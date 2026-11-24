/**
 * Encounter window.
 *
 * The fight runs on the local combat engine (src/systems/mechanics/combat/):
 * every roll, every point of damage, turn order and the end of the fight are
 * decided here. The AI is asked once to set the fight up (stat blocks for
 * allies and enemies) and once at the end for the summary posted to the chat.
 * See docs/COMBAT_DESIGN.md §8 and §9.
 *
 * Flow: narrative style dialog → set-up call → pre-fight preview (edit,
 * regenerate, choose which allies you control) → combat → result, EXP and
 * summary.
 */

import { getContext } from '../../../../../../extensions.js';
import { chat, saveChatDebounced, characters, this_chid, user_avatar } from '../../../../../../../script.js';
import { safeGenerateRaw } from '../../utils/responseExtractor.js';
import { selected_group, getGroupMembers, groups } from '../../../../../../group-chats.js';
import { executeSlashCommandsOnChatInput } from '../../../../../../../scripts/slash-commands.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../../../../popup.js';
import { extensionSettings } from '../../core/state.js';
import { saveSettings } from '../../core/persistence.js';
import { encounterRewards, grantExp } from '../features/experience.js';
import { i18n } from '../../core/i18n.js';
import { getSafeThumbnailUrl } from '../../utils/avatars.js';
import {
    currentEncounter,
    updateCurrentEncounter,
    resetEncounter,
    saveEncounterLog
} from '../features/encounterState.js';
import {
    buildEncounterInitPrompt,
    buildCombatSummaryPrompt,
    parseEncounterJSON
} from '../generation/encounterPrompts.js';
import { normalizeProgression } from '../mechanics/progression.js';
import { TIERS, normalizeStatBlock } from '../mechanics/combat/catalog.js';
import { deriveValues, statBlockPoints, tierBudget } from '../mechanics/combat/costs.js';
import { describeAbility, describeStatBlock } from '../mechanics/combat/describe.js';
import { buildRoster } from '../mechanics/combat/roster.js';
import {
    act, advance, availableActions, conclude, createCombat, describeStatus, effective, getCombatant, hitChance,
    isActive, upcomingPhases, validTargets
} from '../mechanics/combat/engine.js';
import { chooseAction } from '../mechanics/combat/tactics.js';
import { getCombatSettings, playerCombatBlock, trackerFraction } from '../features/sheet.js';

function t(key, fallback) {
    return i18n.getTranslation(key) || fallback;
}

function esc(text) {
    return String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const cap = s => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const SINGLE_TARGETS = ['one-enemy', 'one-ally'];

export class EncounterModal {
    constructor() {
        this.modal = null;
        this.busy = false;
        this.running = false;
        this.ended = false;
        this.closed = false;
        this.roster = null;
        this.player = null;
        this.state = null;
        this.selecting = null;
        this.controlled = new Set();
        this.lastRequest = null;
        /** Pause between AI-controlled actions, so the fight can be followed. */
        this.aiDelay = 600;
    }

    /** Opens the window: narrative style first, then the set-up call. */
    async open() {
        if (this.busy) return;
        const configured = await this.showNarrativeConfigModal();
        if (!configured) return;
        await this.initialize();
    }

    async initialize() {
        if (this.busy) return;
        this.roster = null;
        this.state = null;
        this.selecting = null;
        this.controlled = new Set();
        this.ended = false;
        this.closed = false;
        this._expAwarded = false;
        resetEncounter();
        if (!this.modal) this.createModal();
        this.modal.classList.add('is-open');
        this.modal.setAttribute('data-environment', 'default');
        this.modal.setAttribute('data-atmosphere', 'default');
        await this.requestSetup();
    }

    /* -----------------------------------------------------------------------
       Set-up
       ----------------------------------------------------------------------- */

    async requestSetup() {
        if (this.busy) return;
        this.busy = true;
        this.lastRequest = { type: 'setup' };
        this.showLoadingState(t('encounter.ui.settingUp', 'Setting up the fight...'));
        try {
            const settings = getCombatSettings();
            const progression = normalizeProgression(extensionSettings.progression);
            const player = playerCombatBlock();
            const level = player.level;
            const budgets = Object.fromEntries(Object.keys(TIERS).map(tier => [tier, tierBudget(level, tier, progression.pointsPerLevel, settings)]));
            const prompt = await buildEncounterInitPrompt({
                playerSheet: describeStatBlock(player, deriveValues(player, settings)),
                level,
                budgets,
                perLevel: Math.max(1, Math.round(progression.pointsPerLevel * TIERS.standard.budget))
            });
            const response = await safeGenerateRaw({ prompt, quietToLoud: false });
            if (this.closed) return;
            if (!response) {
                this.showErrorWithRegenerate(t('encounter.ui.error.noResponse', 'No response received from AI. The model may be unavailable.'));
                return;
            }
            const raw = parseEncounterJSON(response);
            const roster = raw && buildRoster(raw, {
                playerName: player.name,
                pointsPerLevel: progression.pointsPerLevel,
                settings,
                skillCost: progression.skillCost,
                attributeCost: progression.attributeCost
            });
            if (!roster || !roster.enemies.length) {
                this.showErrorWithRegenerate(t('encounter.ui.error.noEnemies', 'The AI did not return any usable enemies. Ensure the Max Response Length is at least 2048 tokens, otherwise the reply may be cut off.'));
                return;
            }
            this.player = player;
            this.roster = roster;
            updateCurrentEncounter({ active: true, initialized: true });
            if (roster.styleNotes) this.applyEnvironmentStyling(roster.styleNotes);
            this.showPreview();
        } catch (error) {
            console.error('[RPG Companion] Encounter set-up failed:', error);
            this.showErrorWithRegenerate(`${t('encounter.ui.error.failedToInitialize', 'Failed to initialize combat:')} ${error.message}`);
        } finally {
            this.busy = false;
        }
    }

    async regenerateLastRequest() {
        if (this.lastRequest?.type === 'setup') await this.requestSetup();
    }

    /** Pre-fight preview: every combatant's stat block, with edit and regenerate. */
    showPreview() {
        const main = this.showMain();
        const settings = getCombatSettings();
        const card = (block, kind) => {
            const d = deriveValues(block, settings);
            const isPlayer = kind === 'player';
            const over = block.points !== undefined && block.budget !== undefined;
            return `
                <div class="rpg-combat-preview-card" data-name="${esc(block.name)}" data-kind="${kind}">
                    <div class="rpg-combat-preview-head">
                        ${this.portrait(block, isPlayer)}
                        <div class="rpg-combat-preview-title">
                            <strong>${esc(block.name)}</strong>
                            <span class="rpg-combat-chips">
                                <span class="rpg-combat-chip">${esc(t('encounter.ui.levelShort', 'Lv'))} ${block.level}</span>
                                ${isPlayer ? `<span class="rpg-combat-chip">${esc(t('encounter.ui.you', 'You'))}</span>` : `<span class="rpg-combat-chip rpg-combat-tier-${block.tier}">${esc(TIERS[block.tier]?.label || block.tier)}</span>`}
                                ${over ? `<span class="rpg-combat-chip" title="${esc(t('encounter.ui.pointsHint', 'Points / budget for this level and tier'))}">${block.points} / ${block.budget} pts</span>` : ''}
                                ${block.adjusted ? `<span class="rpg-combat-chip rpg-combat-chip-warn" title="${esc(t('encounter.ui.adjustedHint', 'Was over budget and has been scaled down'))}">${esc(t('encounter.ui.adjusted', 'adjusted'))}</span>` : ''}
                            </span>
                        </div>
                        ${isPlayer ? '' : `<button type="button" class="rpg-combat-icon-btn" data-preview="edit" title="${esc(t('encounter.ui.editStatBlock', 'Edit stat block'))}"><i class="fa-solid fa-pen"></i></button>`}
                    </div>
                    ${block.description ? `<div class="rpg-combat-preview-desc">${esc(block.description)}</div>` : ''}
                    <div class="rpg-combat-preview-stats">HP ${d.maxHp} · END ${d.maxEnd} · SPD ${d.spd} · OCV ${d.ocv} · DCV ${d.dcv} · PD ${d.pd} · ED ${d.ed}</div>
                    <div class="rpg-combat-preview-stats rpg-combat-dim">${Object.entries(block.attributes).map(([k, v]) => `${k.toUpperCase()} ${v}`).join(' · ')}</div>
                    ${Object.keys(block.resistances || {}).length ? `<div class="rpg-combat-preview-stats rpg-combat-dim">${Object.entries(block.resistances).map(([k, v]) => `${esc(cap(v))}: ${esc(k)}`).join(' · ')}</div>` : ''}
                    <ul class="rpg-combat-preview-abilities">
                        ${block.abilities.map(a => `<li><strong>${esc(a.name)}</strong>: ${esc(describeAbility(a))}</li>`).join('')}
                        ${(block.items || []).map(a => `<li><strong>${esc(a.name)}</strong> ×${a.quantity ?? 0}: ${esc(describeAbility(a))}</li>`).join('')}
                    </ul>
                    ${kind === 'ally' ? `
                        <label class="checkbox_label rpg-combat-control">
                            <input type="checkbox" data-preview="control" ${this.controlled.has(block.name) ? 'checked' : ''}>
                            <span>${esc(t('encounter.ui.iControl', 'I choose their actions'))}</span>
                        </label>` : ''}
                </div>`;
        };

        main.innerHTML = `
            <div class="rpg-combat-preview">
                ${this.roster.environment ? `<div class="rpg-encounter-environment"><i class="fa-solid fa-mountain"></i> ${esc(this.roster.environment)}</div>` : ''}
                <h3 class="rpg-combat-heading"><i class="fa-solid fa-users"></i> ${esc(t('encounter.ui.partyTitle', 'Party'))}</h3>
                <div class="rpg-combat-preview-grid">
                    ${card(this.player, 'player')}
                    ${this.roster.party.map(b => card(b, 'ally')).join('')}
                </div>
                <h3 class="rpg-combat-heading"><i class="fa-solid fa-skull"></i> ${esc(t('encounter.ui.enemiesTitle', 'Enemies'))}</h3>
                <div class="rpg-combat-preview-grid">
                    ${this.roster.enemies.map(b => card(b, 'enemy')).join('')}
                </div>
                <div class="rpg-combat-preview-actions">
                    <button type="button" class="rpg-btn rpg-btn-secondary" data-preview="regenerate"><i class="fa-solid fa-rotate-right"></i> ${esc(t('encounter.ui.regenerateEnemies', 'Regenerate'))}</button>
                    <button type="button" class="rpg-btn rpg-btn-primary" data-preview="start"><i class="fa-solid fa-swords"></i> ${esc(t('encounter.ui.startFight', 'Start the fight'))}</button>
                </div>
            </div>`;

        main.querySelector('[data-preview="start"]').addEventListener('click', () => this.startFight());
        main.querySelector('[data-preview="regenerate"]').addEventListener('click', () => this.requestSetup());
        main.querySelectorAll('[data-preview="control"]').forEach(box => box.addEventListener('change', () => {
            const name = box.closest('.rpg-combat-preview-card').dataset.name;
            if (box.checked) this.controlled.add(name);
            else this.controlled.delete(name);
        }));
        main.querySelectorAll('[data-preview="edit"]').forEach(btn => btn.addEventListener('click', () => {
            const cardEl = btn.closest('.rpg-combat-preview-card');
            this.editStatBlock(cardEl.dataset.kind === 'ally' ? 'party' : 'enemies', cardEl.dataset.name);
        }));
    }

    /** Edits one stat block as JSON. Your edits are not scaled to budget. */
    async editStatBlock(list, name) {
        const blocks = this.roster[list];
        const index = blocks.findIndex(b => b.name === name);
        if (index < 0) return;
        const { budget, points, adjusted, ...plain } = blocks[index];
        const $editor = $(`
            <div class="rpg-combat-json-editor">
                <h3>${esc(name)}</h3>
                <small>${esc(t('encounter.ui.editHint', 'The stat block as JSON (see docs/COMBAT_DESIGN.md §10). Your edits are kept as they are, without budget scaling.'))}</small>
                <textarea class="text_pole" rows="18" spellcheck="false"></textarea>
            </div>`);
        $editor.find('textarea').val(JSON.stringify(plain, null, 2));
        const result = await callGenericPopup($editor, POPUP_TYPE.CONFIRM, '', {
            okButton: t('sheet.save', 'Save'),
            cancelButton: t('global.cancel', 'Cancel'),
            wide: true,
            allowVerticalScrolling: true
        });
        if (result !== POPUP_RESULT.AFFIRMATIVE) return;
        let block;
        try {
            block = normalizeStatBlock(JSON.parse(String($editor.find('textarea').val())));
        } catch (error) {
            toastr.error(esc(error.message), t('encounter.ui.invalidJson', 'That is not valid JSON'));
            return;
        }
        if (!block) {
            toastr.error(t('encounter.ui.invalidStatBlock', 'A stat block needs at least a name.'));
            return;
        }
        const progression = normalizeProgression(extensionSettings.progression);
        block.budget = tierBudget(block.level, block.tier, progression.pointsPerLevel, getCombatSettings());
        block.points = statBlockPoints(block, { skillCost: progression.skillCost, attributeCost: progression.attributeCost }).total;
        if (this.controlled.has(name) && block.name !== name) {
            this.controlled.delete(name);
            this.controlled.add(block.name);
        }
        blocks[index] = block;
        this.showPreview();
    }

    /* -----------------------------------------------------------------------
       The fight
       ----------------------------------------------------------------------- */

    startFight() {
        const settings = getCombatSettings();
        const d = deriveValues(this.player, settings);
        const health = trackerFraction('health');
        const energy = trackerFraction('energy');
        const participants = [
            {
                block: this.player,
                side: 'party',
                isPlayer: true,
                hp: health === null ? undefined : Math.max(1, Math.round(d.maxHp * health)),
                end: energy === null ? undefined : Math.round(d.maxEnd * energy)
            },
            ...this.roster.party.map(block => ({ block, side: 'party', controlled: this.controlled.has(block.name) ? 'player' : 'ai' })),
            ...this.roster.enemies.map(block => ({ block, side: 'enemies' }))
        ];
        this.state = createCombat(participants, { settings });
        this.selecting = null;
        this.renderBattle();
        this.run();
    }

    /** Runs phases until it's a player-controlled combatant's turn or the fight ends. */
    async run() {
        if (this.running || !this.state) return;
        this.running = true;
        try {
            while (!this.state.over && !this.closed) {
                const id = advance(this.state);
                if (!id) break;
                const c = getCombatant(this.state, id);
                this.renderBattle();
                if (c.controlled === 'player') return;
                if (this.aiDelay) await sleep(this.aiDelay);
                if (this.closed || this.state.over) break;
                act(this.state, chooseAction(this.state, id));
                this.renderBattle();
            }
        } finally {
            this.running = false;
        }
        if (this.state?.over && !this.closed) await this.endCombat(this.state.result);
    }

    /** The current player-controlled combatant takes an action. */
    playerAction(action) {
        const current = this.state && getCombatant(this.state, this.state.current);
        if (!current || current.controlled !== 'player' || this.running) return;
        this.selecting = null;
        act(this.state, action);
        this.renderBattle();
        this.run();
    }

    /** Ability or item clicked: act now, or pick a target first. */
    chooseAbility(kind, id) {
        const current = getCombatant(this.state, this.state.current);
        const { abilities, items } = availableActions(this.state, current.id);
        const option = (kind === 'item' ? items : abilities).find(o => o.ability.id === id);
        if (!option || !option.usable) return;
        const ability = option.ability;
        const type = kind === 'item' ? 'item' : 'ability';
        const key = kind === 'item' ? 'itemId' : 'abilityId';
        const targets = validTargets(this.state, current.id, ability);
        if (!SINGLE_TARGETS.includes(ability.target) || (ability.target === 'one-ally' && targets.length === 1)) {
            this.playerAction({ type, [key]: id, targetId: targets[0] });
            return;
        }
        this.selecting = { type, key, id, ability, targets };
        this.renderBattle();
    }

    renderBattle() {
        if (!this.state || this.ended) return;
        const main = this.showMain();
        const state = this.state;
        const current = getCombatant(state, state.current);
        const playerTurn = current && current.controlled === 'player' && !state.over;
        const logEl = main.querySelector('.rpg-combat-log');
        const atBottom = !logEl || logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;

        const side = name => state.combatants.filter(c => c.side === name);
        main.innerHTML = `
            <div class="rpg-combat">
                ${this.roster.environment ? `<div class="rpg-encounter-environment"><i class="fa-solid fa-mountain"></i> ${esc(this.roster.environment)}</div>` : ''}
                ${this.renderTimeline()}
                <h3 class="rpg-combat-heading"><i class="fa-solid fa-skull"></i> ${esc(t('encounter.ui.enemiesTitle', 'Enemies'))}</h3>
                <div class="rpg-combat-grid">${side('enemies').map(c => this.renderCard(c)).join('')}</div>
                <h3 class="rpg-combat-heading"><i class="fa-solid fa-users"></i> ${esc(t('encounter.ui.partyTitle', 'Party'))}</h3>
                <div class="rpg-combat-grid">${side('party').map(c => this.renderCard(c)).join('')}</div>
                ${playerTurn ? this.renderActionBar(current) : `<div class="rpg-combat-waiting">${current ? `<i class="fa-solid fa-hourglass-half"></i> ${esc(current.name)}…` : ''}</div>`}
                <h3 class="rpg-combat-heading"><i class="fa-solid fa-scroll"></i> ${esc(t('encounter.ui.combatLog', 'Combat Log'))}</h3>
                <div class="rpg-combat-log">${this.renderLog()}</div>
            </div>`;

        const log = main.querySelector('.rpg-combat-log');
        if (atBottom) log.scrollTop = log.scrollHeight;

        main.querySelectorAll('[data-combat-ability]').forEach(btn => btn.addEventListener('click', () => this.chooseAbility('ability', btn.dataset.combatAbility)));
        main.querySelectorAll('[data-combat-item]').forEach(btn => btn.addEventListener('click', () => this.chooseAbility('item', btn.dataset.combatItem)));
        main.querySelectorAll('[data-combat-basic]').forEach(btn => btn.addEventListener('click', () => this.playerAction({ type: btn.dataset.combatBasic })));
        main.querySelector('[data-combat-cancel]')?.addEventListener('click', () => { this.selecting = null; this.renderBattle(); });
        main.querySelectorAll('.rpg-combat-card.is-target').forEach(cardEl => cardEl.addEventListener('click', () => {
            const s = this.selecting;
            this.playerAction({ type: s.type, [s.key]: s.id, targetId: cardEl.dataset.id });
        }));
    }

    renderTimeline() {
        // The combatant acting now, then who comes next.
        const now = this.state.current ? [{ turn: this.state.turn, segment: this.state.segment, id: this.state.current }] : [];
        const phases = [...now, ...upcomingPhases(this.state, 12 - now.length)];
        return `
            <div class="rpg-combat-timeline" title="${esc(t('encounter.ui.timelineHint', 'Who acts next: turn.segment of the 12-segment turn'))}">
                ${phases.map((p, i) => {
                    const c = getCombatant(this.state, p.id);
                    return `<span class="rpg-combat-tick rpg-combat-${c.side}${i === 0 && this.state.current === p.id ? ' is-current' : ''}">
                        <small>${p.turn}.${p.segment}</small>${esc(c.name.length > 12 ? `${c.name.slice(0, 11)}…` : c.name)}</span>`;
                }).join('')}
            </div>`;
    }

    renderCard(c) {
        const state = this.state;
        const eff = effective(state, c);
        const hp = Math.round((c.hp / Math.max(1, c.maxHp)) * 100);
        const end = Math.round((c.end / Math.max(1, c.maxEnd)) * 100);
        const s = this.selecting;
        const target = s && s.targets.includes(c.id);
        const chance = target ? Math.round(hitChance(state, state.current, s.ability, c.id) * 100) : null;
        const classes = [
            'rpg-combat-card',
            `rpg-combat-${c.side}`,
            state.current === c.id ? 'is-current' : '',
            !isActive(c) ? 'is-out' : '',
            target ? 'is-target' : ''
        ].filter(Boolean).join(' ');
        const statusChips = c.statuses.map(st => `<span class="rpg-combat-status" title="${esc(describeStatus(st))}">${esc(st.name)} ${st.remaining}</span>`).join('');
        return `
            <div class="${classes}" data-id="${c.id}">
                ${this.portrait(c.block, c.isPlayer)}
                <div class="rpg-combat-card-body">
                    <div class="rpg-combat-card-name">
                        <strong>${esc(c.name)}</strong>
                        <span class="rpg-combat-chip">${esc(t('encounter.ui.levelShort', 'Lv'))} ${c.block.level}</span>
                        ${c.side === 'enemies' && c.block.tier !== 'standard' ? `<span class="rpg-combat-chip rpg-combat-tier-${c.block.tier}">${esc(TIERS[c.block.tier]?.label || '')}</span>` : ''}
                        ${c.fled ? `<span class="rpg-combat-chip">${esc(t('encounter.ui.fled', 'fled'))}</span>` : ''}
                    </div>
                    <div class="rpg-combat-bar rpg-combat-hp" title="HP"><div style="width:${hp}%"></div><span>${c.hp}/${c.maxHp} HP</span></div>
                    <div class="rpg-combat-bar rpg-combat-end" title="END"><div style="width:${end}%"></div><span>${c.end}/${c.maxEnd} END</span></div>
                    <div class="rpg-combat-card-stats">SPD ${eff.spd} · DCV ${eff.dcv}${c.dodging ? '+3' : ''} · PD ${eff.pd} · ED ${eff.ed}</div>
                    ${statusChips ? `<div class="rpg-combat-statuses">${statusChips}</div>` : ''}
                </div>
                ${chance !== null ? `<span class="rpg-combat-chance">${chance}%</span>` : ''}
            </div>`;
    }

    renderActionBar(current) {
        const state = this.state;
        const s = this.selecting;
        const header = `
            <div class="rpg-combat-actions-head">
                <strong>${esc(current.name)}</strong>
                <span class="rpg-combat-dim">${esc(t('encounter.ui.turnSegment', 'Turn {turn}, segment {segment}').replace('{turn}', state.turn).replace('{segment}', state.segment))} · END ${current.end}/${current.maxEnd}</span>
            </div>`;
        if (s) {
            return `
                <div class="rpg-combat-actions">
                    ${header}
                    <div class="rpg-combat-selecting">
                        <span><i class="fa-solid fa-crosshairs"></i> ${esc(t('encounter.ui.chooseTarget', 'Choose a target for {name}').replace('{name}', s.ability.name))}</span>
                        <button type="button" class="rpg-btn rpg-btn-secondary" data-combat-cancel><i class="fa-solid fa-xmark"></i> ${esc(t('global.cancel', 'Cancel'))}</button>
                    </div>
                </div>`;
        }
        const { abilities, items } = availableActions(state, current.id);
        const abilityButton = o => {
            const notes = [];
            if (o.end) notes.push(`${o.end} END`);
            if (o.charges !== undefined) notes.push(`${o.charges} ${esc(t('encounter.ui.left', 'left'))}`);
            return `<button type="button" class="rpg-combat-action${o.end > current.end ? ' is-strain' : ''}" data-combat-ability="${esc(o.ability.id)}" ${o.usable ? '' : 'disabled'} title="${esc(describeAbility(o.ability))}${o.end > current.end ? esc(` (${t('encounter.ui.strainHint', 'not enough END: the rest is paid in HP')})`) : ''}">
                <span>${esc(o.ability.name)}</span>${notes.length ? `<small>${notes.join(' · ')}</small>` : ''}</button>`;
        };
        const itemButton = o => `
            <button type="button" class="rpg-combat-action" data-combat-item="${esc(o.ability.id)}" ${o.usable ? '' : 'disabled'} title="${esc(describeAbility(o.ability))}">
                <span>${esc(o.ability.name)}</span><small>×${o.quantity}</small></button>`;
        const basic = (type, icon, label, hint) => `
            <button type="button" class="rpg-combat-action rpg-combat-basic" data-combat-basic="${type}" title="${esc(hint)}"><span><i class="fa-solid ${icon}"></i> ${esc(label)}</span></button>`;
        return `
            <div class="rpg-combat-actions">
                ${header}
                <div class="rpg-combat-action-row">${abilities.map(abilityButton).join('')}</div>
                ${items.length ? `<div class="rpg-combat-action-row">${items.map(itemButton).join('')}</div>` : ''}
                <div class="rpg-combat-action-row">
                    ${basic('dodge', 'fa-person-falling', t('encounter.ui.dodge', 'Dodge'), t('encounter.ui.dodgeHint', '+3 DCV until your next phase'))}
                    ${basic('recover', 'fa-lungs', t('encounter.ui.recover', 'Recover'), t('encounter.ui.recoverHint', 'Regain your REC in END'))}
                    ${basic('flee', 'fa-person-running', t('encounter.ui.flee', 'Flee'), t('encounter.ui.fleeHint', 'DEX roll against the fastest enemy; success ends the fight'))}
                    ${basic('pass', 'fa-hourglass', t('encounter.ui.wait', 'Wait'), t('encounter.ui.waitHint', 'Do nothing this phase'))}
                </div>
            </div>`;
    }

    renderLog() {
        let last = '';
        const out = [];
        for (const entry of this.state.log) {
            const mark = `${entry.turn}.${entry.segment}`;
            if (entry.actorId && mark !== last) {
                out.push(`<div class="rpg-combat-log-mark">${esc(t('encounter.ui.turnSegment', 'Turn {turn}, segment {segment}').replace('{turn}', entry.turn).replace('{segment}', entry.segment))}</div>`);
                last = mark;
            }
            const actor = entry.actorId ? getCombatant(this.state, entry.actorId) : null;
            out.push(`<div class="rpg-combat-log-entry rpg-combat-log-${actor ? actor.side : 'system'} rpg-combat-log-${entry.kind}">${esc(entry.text)}</div>`);
        }
        return out.join('');
    }

    /** Avatar for named characters, the emoji sprite otherwise. */
    portrait(block, isPlayer = false) {
        const url = isPlayer ? (user_avatar ? getSafeThumbnailUrl('persona', user_avatar) : null) : this.getCharacterAvatar(block.name);
        const sprite = esc(block.sprite || (isPlayer ? '🧑' : '👹'));
        if (url) return `<span class="rpg-combat-portrait"><img src="${esc(url)}" alt="" onerror="this.parentElement.textContent='${sprite}'"></span>`;
        return `<span class="rpg-combat-portrait">${sprite}</span>`;
    }

    /* -----------------------------------------------------------------------
       The end
       ----------------------------------------------------------------------- */

    async concludeEncounter() {
        if (!this.state) {
            this.close();
            return;
        }
        if (this.ended) return;
        conclude(this.state, 'interrupted');
        if (!this.running) await this.endCombat(this.state.result);
    }

    async endCombat(result) {
        if (this.ended) return;
        this.ended = true;
        try {
            this.showCombatOverScreen(result);
            this.awardCombatExp(result);

            const lines = [];
            let last = '';
            for (const entry of this.state.log) {
                const mark = `Turn ${entry.turn}, segment ${entry.segment}`;
                if (entry.actorId && mark !== last) {
                    lines.push(`[${mark}]`);
                    last = mark;
                }
                lines.push(entry.text);
            }
            currentEncounter.encounterLog = lines;

            const summaryPrompt = await buildCombatSummaryPrompt(lines, result);
            const response = await safeGenerateRaw({ prompt: summaryPrompt, quietToLoud: false });
            if (!response) {
                this.updateCombatOverScreen(false);
                return;
            }
            const summary = response.replace(/\[FIGHT CONCLUDED\]\s*/i, '').trim();
            const speakerName = this.getCombatNarrator();
            try {
                await executeSlashCommandsOnChatInput(`/sendas name="${speakerName}" ${summary}`, { clearChatInput: false });
                this.updateCombatOverScreen(true, speakerName);
            } catch (sendError) {
                console.error('[RPG Companion] Error using /sendas command:', sendError);
                const lastMessage = chat?.[chat.length - 1];
                if (lastMessage) {
                    lastMessage.mes += '\n\n' + summary;
                    saveChatDebounced();
                }
                this.updateCombatOverScreen(true, 'chat');
            }
            const context = getContext();
            if (context.chatId) saveEncounterLog(context.chatId, { log: lines, summary, result });
        } catch (error) {
            console.error('[RPG Companion] Error ending combat:', error);
            this.updateCombatOverScreen(false);
        }
    }

    /** EXP for beaten enemies (all on a victory, otherwise those brought to 0 HP), scaled by tier. */
    awardCombatExp(result) {
        if (this._expAwarded) return;
        this._expAwarded = true;
        const enemies = this.state.combatants
            .filter(c => c.side === 'enemies' && !c.fled)
            .map(c => ({ name: c.name, hp: c.hp, level: c.block.level, tier: c.block.tier }));
        const rewards = encounterRewards(enemies, result);
        if (!rewards.total) return;
        grantExp(rewards.total, t('progression.encounterDone', 'Encounter'));

        const overScreen = this.modal?.querySelector('.rpg-encounter-over');
        if (!overScreen) return;
        const lvl = t('encounter.ui.levelShort', 'Lv');
        const list = document.createElement('div');
        list.className = 'rpg-encounter-exp';
        list.innerHTML = `<div class="rpg-encounter-exp-total">+${rewards.total} ${esc(t('progression.exp', 'EXP'))}</div>`
            + rewards.enemies.map(e => `<div>${esc(e.name)} <span>(${lvl} ${e.level}${e.tier !== 'standard' ? `, ${esc(e.tier)}` : ''})</span> +${e.exp}</div>`).join('');
        overScreen.querySelector('h2')?.after(list);
    }

    showCombatOverScreen(result) {
        const main = this.showMain();
        const icons = { victory: 'fa-trophy', defeat: 'fa-skull-crossbones', escaped: 'fa-person-running', fled: 'fa-person-running', interrupted: 'fa-flag-checkered' };
        const colors = { victory: 'var(--rpg-success)', defeat: 'var(--rpg-danger)', escaped: 'var(--rpg-highlight)', fled: 'var(--rpg-highlight)', interrupted: 'var(--rpg-muted)' };
        const texts = {
            victory: t('encounter.ui.result.victory', 'Victory'),
            defeat: t('encounter.ui.result.defeat', 'Defeat'),
            escaped: t('encounter.ui.result.escaped', 'Escaped'),
            fled: t('encounter.ui.result.fled', 'Fled'),
            interrupted: t('encounter.ui.result.interrupted', 'Interrupted')
        };
        main.innerHTML = `
            <div class="rpg-encounter-over">
                <i class="fa-solid ${icons[result] || 'fa-flag-checkered'}" style="color: ${colors[result] || 'var(--rpg-muted)'}"></i>
                <h2>${esc(texts[result] || result)}</h2>
                <p>${esc(t('encounter.ui.generatingCombatSummary', 'Generating combat summary...'))}</p>
                <div class="rpg-encounter-over-actions"><i class="fa-solid fa-spinner fa-spin"></i></div>
            </div>`;
    }

    updateCombatOverScreen(success, speakerName = '') {
        const overScreen = this.modal?.querySelector('.rpg-encounter-over');
        if (!overScreen) return;
        overScreen.querySelector('p').textContent = success
            ? (speakerName
                ? t('encounter.ui.combatSummaryAddedBy', 'Combat summary has been added to the chat by {speakerName}.').replace('{speakerName}', speakerName)
                : t('encounter.ui.combatSummaryAdded', 'Combat summary has been added to the chat.'))
            : t('encounter.ui.failedToCreateSummary', 'Failed to create summary. You can close this window.');
        const actions = overScreen.querySelector('.rpg-encounter-over-actions');
        actions.innerHTML = `<button type="button" class="rpg-btn rpg-btn-primary" id="rpg-encounter-close-final"><i class="fa-solid fa-check"></i> ${esc(t('encounter.ui.closeCombatWindow', 'Close Combat Window'))}</button>`;
        actions.querySelector('button').addEventListener('click', () => this.close());
    }

    /* -----------------------------------------------------------------------
       Window
       ----------------------------------------------------------------------- */

    createModal() {
        document.body.insertAdjacentHTML('beforeend', `
            <div id="rpg-encounter-modal" class="rpg-encounter-modal" data-theme="${esc(extensionSettings.theme || 'default')}" data-environment="default" data-atmosphere="default">
                <div class="rpg-encounter-overlay"></div>
                <div class="rpg-encounter-container">
                    <div class="rpg-encounter-header">
                        <h2><i class="fa-solid fa-swords"></i> ${esc(t('encounter.ui.combatEncounterTitle', 'Combat Encounter'))}</h2>
                        <div class="rpg-encounter-header-buttons">
                            <button id="rpg-encounter-conclude" class="rpg-encounter-conclude-btn" title="${esc(t('encounter.ui.concludeEncounterTitle', 'Conclude encounter early'))}">
                                <i class="fa-solid fa-flag-checkered"></i> ${esc(t('encounter.ui.concludeEncounterButton', 'Conclude Encounter'))}
                            </button>
                            <button id="rpg-encounter-close" class="rpg-encounter-close-btn" title="${esc(t('encounter.ui.closeTitle', 'Close (ends combat)'))}">
                                <i class="fa-solid fa-times"></i>
                            </button>
                        </div>
                    </div>
                    <div class="rpg-encounter-content">
                        <div id="rpg-encounter-loading" class="rpg-encounter-loading">
                            <i class="fa-solid fa-spinner fa-spin"></i>
                            <p>${esc(t('encounter.ui.initializingCombat', 'Initializing combat...'))}</p>
                        </div>
                        <div id="rpg-encounter-main" class="rpg-encounter-main" style="display: none;"></div>
                    </div>
                </div>
            </div>`);
        this.modal = document.getElementById('rpg-encounter-modal');

        this.modal.querySelector('#rpg-encounter-conclude').addEventListener('click', () => {
            if (this.ended) return;
            if (!this.state || confirm(t('encounter.ui.confirmConcludeEarly', 'Conclude this encounter early and generate a summary?'))) {
                this.concludeEncounter();
            }
        });
        const askClose = () => {
            if (this.ended || !this.state || confirm(t('encounter.ui.confirmEndCombat', 'Are you sure you want to end this combat encounter?'))) {
                this.close();
            }
        };
        this.modal.querySelector('#rpg-encounter-close').addEventListener('click', askClose);
        this.modal.querySelector('.rpg-encounter-overlay').addEventListener('click', askClose);
    }

    /** Shows the main area (hiding the loading/error area) and returns it. */
    showMain() {
        const loading = this.modal.querySelector('#rpg-encounter-loading');
        const main = this.modal.querySelector('#rpg-encounter-main');
        loading.style.display = 'none';
        main.style.display = 'block';
        return main;
    }

    showLoadingState(message) {
        const loading = this.modal.querySelector('#rpg-encounter-loading');
        const main = this.modal.querySelector('#rpg-encounter-main');
        loading.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i><p>${esc(message)}</p>`;
        loading.style.display = 'flex';
        main.style.display = 'none';
    }

    showErrorWithRegenerate(message) {
        const loading = this.modal.querySelector('#rpg-encounter-loading');
        this.modal.querySelector('#rpg-encounter-main').style.display = 'none';
        loading.style.display = 'flex';
        loading.innerHTML = `
            <div class="rpg-encounter-error-box">
                <i class="fa-solid fa-exclamation-triangle"></i>
                <p class="rpg-encounter-error-title">${esc(t('encounter.ui.wrongFormatDetected', 'Wrong Format Detected'))}</p>
                <p>${esc(message)}</p>
                <div class="rpg-encounter-error-actions">
                    <button id="rpg-error-regenerate" class="rpg-btn rpg-btn-primary"><i class="fa-solid fa-rotate-right"></i> ${esc(t('encounter.ui.regenerate', 'Regenerate'))}</button>
                    <button id="rpg-error-close" class="rpg-btn rpg-btn-secondary"><i class="fa-solid fa-times"></i> ${esc(t('global.close', 'Close'))}</button>
                </div>
            </div>`;
        loading.querySelector('#rpg-error-regenerate').addEventListener('click', () => this.regenerateLastRequest());
        loading.querySelector('#rpg-error-close').addEventListener('click', () => this.close());
    }

    close() {
        this.closed = true;
        if (this.modal) this.modal.classList.remove('is-open');
        resetEncounter();
    }

    /* -----------------------------------------------------------------------
       Kept from the previous window: narrative style, avatars, narrator, styling
       ----------------------------------------------------------------------- */

    /**
     * Shows narrative configuration modal before starting encounter
     * @returns {Promise<boolean>} True if configured, false if cancelled
     */
    async showNarrativeConfigModal() {
        return new Promise((resolve) => {
            // Get current values or defaults
            const combatDefaults = extensionSettings.encounterSettings?.combatNarrative || {};
            const summaryDefaults = extensionSettings.encounterSettings?.summaryNarrative || {};

            const configHTML = `
                <div id="rpg-narrative-config-modal" class="rpg-encounter-modal" data-theme="${extensionSettings.theme || 'default'}">
                    <div class="rpg-encounter-overlay"></div>
                    <div class="rpg-encounter-container" style="max-width: 600px;">
                        <div class="rpg-encounter-header">
                            <h2><i class="fa-solid fa-book-open"></i> ${i18n.getTranslation('encounter.configModal.title') || 'Configure Combat Narrative'}</h2>
                        </div>
                        <div class="rpg-encounter-content" style="padding: 24px;">
                            <div class="rpg-narrative-config-section">
                                <label class="label_text" style="margin-bottom: 16px; display: block; font-weight: 600;">
                                    <i class="fa-solid fa-swords"></i> ${i18n.getTranslation('encounter.configModal.combatNarrativeStyle') || 'Combat Narrative Style'}
                                </label>

                                <div class="rpg-setting-row" style="margin-bottom: 12px;">
                                    <label for="config-combat-tense" style="min-width: 100px;">${i18n.getTranslation('encounter.configModal.labels.tense') || 'Tense:'}</label>
                                    <select id="config-combat-tense" class="rpg-select" style="flex: 1;">
                                        <option value="present" ${combatDefaults.tense === 'present' ? 'selected' : ''}>${i18n.getTranslation('encounter.configModal.options.present') || 'Present'}</option>
                                        <option value="past" ${combatDefaults.tense === 'past' ? 'selected' : ''}>${i18n.getTranslation('encounter.configModal.options.past') || 'Past'}</option>
                                    </select>
                                </div>

                                <div class="rpg-setting-row" style="margin-bottom: 12px;">
                                    <label for="config-combat-person" style="min-width: 100px;">${i18n.getTranslation('encounter.configModal.labels.person') || 'Person:'}</label>
                                    <select id="config-combat-person" class="rpg-select" style="flex: 1;">
                                        <option value="first" ${combatDefaults.person === 'first' ? 'selected' : ''}>${i18n.getTranslation('encounter.configModal.options.firstPerson') || 'First Person'}</option>
                                        <option value="second" ${combatDefaults.person === 'second' ? 'selected' : ''}>${i18n.getTranslation('encounter.configModal.options.secondPerson') || 'Second Person'}</option>
                                        <option value="third" ${combatDefaults.person === 'third' ? 'selected' : ''}>${i18n.getTranslation('encounter.configModal.options.thirdPerson') || 'Third Person'}</option>
                                    </select>
                                </div>

                                <div class="rpg-setting-row" style="margin-bottom: 12px;">
                                    <label for="config-combat-narration" style="min-width: 100px;">${i18n.getTranslation('encounter.configModal.labels.narration') || 'Narration:'}</label>
                                    <select id="config-combat-narration" class="rpg-select" style="flex: 1;">
                                        <option value="omniscient" ${combatDefaults.narration === 'omniscient' ? 'selected' : ''}>${i18n.getTranslation('encounter.configModal.options.omniscient') || 'Omniscient'}</option>
                                        <option value="limited" ${combatDefaults.narration === 'limited' ? 'selected' : ''}>${i18n.getTranslation('encounter.configModal.options.limited') || 'Limited'}</option>
                                    </select>
                                </div>

                                <div class="rpg-setting-row" style="margin-bottom: 12px;">
                                    <label for="config-combat-pov" style="min-width: 100px;">${i18n.getTranslation('encounter.configModal.labels.pointOfView') || 'Point of View:'}</label>
                                    <input type="text" id="config-combat-pov" class="text_pole" placeholder="${i18n.getTranslation('encounter.configModal.placeholders.narrator') || 'narrator'}" value="${combatDefaults.pov || ''}" style="flex: 1;" />
                                </div>
                            </div>

                            <div class="rpg-narrative-config-section" style="margin-top: 24px; padding-top: 24px; border-top: 1px solid var(--rpg-border, rgba(255,255,255,0.1));">
                                <label class="label_text" style="margin-bottom: 16px; display: block; font-weight: 600;">
                                    <i class="fa-solid fa-scroll"></i> ${i18n.getTranslation('encounter.configModal.combatSummaryStyle') || 'Combat Summary Style'}
                                </label>

                                <div class="rpg-setting-row" style="margin-bottom: 12px;">
                                    <label for="config-summary-tense" style="min-width: 100px;">${i18n.getTranslation('encounter.configModal.labels.tense') || 'Tense:'}</label>
                                    <select id="config-summary-tense" class="rpg-select" style="flex: 1;">
                                        <option value="present" ${summaryDefaults.tense === 'present' ? 'selected' : ''}>${i18n.getTranslation('encounter.configModal.options.present') || 'Present'}</option>
                                        <option value="past" ${summaryDefaults.tense === 'past' ? 'selected' : ''}>${i18n.getTranslation('encounter.configModal.options.past') || 'Past'}</option>
                                    </select>
                                </div>

                                <div class="rpg-setting-row" style="margin-bottom: 12px;">
                                    <label for="config-summary-person" style="min-width: 100px;">${i18n.getTranslation('encounter.configModal.labels.person') || 'Person:'}</label>
                                    <select id="config-summary-person" class="rpg-select" style="flex: 1;">
                                        <option value="first" ${summaryDefaults.person === 'first' ? 'selected' : ''}>${i18n.getTranslation('encounter.configModal.options.firstPerson') || 'First Person'}</option>
                                        <option value="second" ${summaryDefaults.person === 'second' ? 'selected' : ''}>${i18n.getTranslation('encounter.configModal.options.secondPerson') || 'Second Person'}</option>
                                        <option value="third" ${summaryDefaults.person === 'third' ? 'selected' : ''}>${i18n.getTranslation('encounter.configModal.options.thirdPerson') || 'Third Person'}</option>
                                    </select>
                                </div>

                                <div class="rpg-setting-row" style="margin-bottom: 12px;">
                                    <label for="config-summary-narration" style="min-width: 100px;">${i18n.getTranslation('encounter.configModal.labels.narration') || 'Narration:'}</label>
                                    <select id="config-summary-narration" class="rpg-select" style="flex: 1;">
                                        <option value="omniscient" ${summaryDefaults.narration === 'omniscient' ? 'selected' : ''}>${i18n.getTranslation('encounter.configModal.options.omniscient') || 'Omniscient'}</option>
                                        <option value="limited" ${summaryDefaults.narration === 'limited' ? 'selected' : ''}>${i18n.getTranslation('encounter.configModal.options.limited') || 'Limited'}</option>
                                    </select>
                                </div>

                                <div class="rpg-setting-row" style="margin-bottom: 12px;">
                                    <label for="config-summary-pov" style="min-width: 100px;">${i18n.getTranslation('encounter.configModal.labels.pointOfView') || 'Point of View:'}</label>
                                    <input type="text" id="config-summary-pov" class="text_pole" placeholder="${i18n.getTranslation('encounter.configModal.placeholders.narrator') || 'narrator'}" value="${summaryDefaults.pov || ''}" style="flex: 1;" />
                                </div>
                            </div>

                            <div style="margin-top: 24px; padding-top: 24px; border-top: 1px solid var(--rpg-border, rgba(255,255,255,0.1));">
                                <label class="checkbox_label" style="display: flex; align-items: center; gap: 8px;">
                                    <input type="checkbox" id="config-remember" ${extensionSettings.encounterSettings?.narrativeConfigured ? 'checked' : ''} style="margin: 0;" />
                                    <span style="color: var(--rpg-text, #eaeaea);">${i18n.getTranslation('encounter.configModal.rememberSettings') || 'Remember these settings for future encounters'}</span>
                                </label>
                            </div>

                            <div style="margin-top: 24px; display: flex; gap: 12px; justify-content: flex-end;">
                                <button id="config-cancel" class="rpg-btn rpg-btn-secondary" style="padding: 12px 24px;">
                                    <i class="fa-solid fa-times"></i> ${i18n.getTranslation('global.cancel') || 'Cancel'}
                                </button>
                                <button id="config-proceed" class="rpg-btn rpg-btn-primary" style="padding: 12px 24px;">
                                    <i class="fa-solid fa-play"></i> ${i18n.getTranslation('encounter.configModal.buttons.proceed') || 'Proceed'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            `;

            document.body.insertAdjacentHTML('beforeend', configHTML);
            const configModal = document.getElementById('rpg-narrative-config-modal');

            // Show modal
            setTimeout(() => configModal.classList.add('is-open'), 10);

            // Handle proceed
            configModal.querySelector('#config-proceed').addEventListener('click', () => {
                // Get values
                const combatNarrative = {
                    tense: configModal.querySelector('#config-combat-tense').value,
                    person: configModal.querySelector('#config-combat-person').value,
                    narration: configModal.querySelector('#config-combat-narration').value,
                    pov: configModal.querySelector('#config-combat-pov').value.trim() || 'narrator'
                };

                const summaryNarrative = {
                    tense: configModal.querySelector('#config-summary-tense').value,
                    person: configModal.querySelector('#config-summary-person').value,
                    narration: configModal.querySelector('#config-summary-narration').value,
                    pov: configModal.querySelector('#config-summary-pov').value.trim() || 'narrator'
                };

                const remember = configModal.querySelector('#config-remember').checked;

                // Save to settings
                if (!extensionSettings.encounterSettings) {
                    extensionSettings.encounterSettings = {};
                }
                extensionSettings.encounterSettings.combatNarrative = combatNarrative;
                extensionSettings.encounterSettings.summaryNarrative = summaryNarrative;

                // Set narrativeConfigured based on checkbox state
                extensionSettings.encounterSettings.narrativeConfigured = remember;

                // Save settings
                saveSettings();

                // Clean up
                configModal.remove();
                resolve(true);
            });

            // Handle cancel
            configModal.querySelector('#config-cancel').addEventListener('click', () => {
                configModal.remove();
                resolve(false);
            });

            // Handle overlay click
            configModal.querySelector('.rpg-encounter-overlay').addEventListener('click', () => {
                configModal.remove();
                resolve(false);
            });
        });
    }

    /**
     * Gets avatar for a character by name (works for party members, enemies, and NPCs)
     * @param {string} name - Character name
     * @returns {string} Avatar URL or null
     */
    getCharacterAvatar(name) {
        // Priority 1: Check custom uploaded avatars first (from Present Characters panel)
        if (extensionSettings.npcAvatars && extensionSettings.npcAvatars[name]) {
            return extensionSettings.npcAvatars[name];
        }

        // Priority 2: Check if character is in the current group
        if (selected_group) {
            const groupMembers = getGroupMembers(selected_group);
            if (groupMembers && groupMembers.length > 0) {
                const matchingMember = groupMembers.find(member =>
                    member && member.name && member.name.toLowerCase() === name.toLowerCase()
                );

                if (matchingMember && matchingMember.avatar) {
                    return getSafeThumbnailUrl('avatar', matchingMember.avatar);
                }
            }
        }

        // Priority 3: Search all loaded characters
        if (characters && Array.isArray(characters)) {
            const matchingChar = characters.find(char =>
                char && char.name && char.name.toLowerCase() === name.toLowerCase()
            );

            if (matchingChar && matchingChar.avatar) {
                return getSafeThumbnailUrl('avatar', matchingChar.avatar);
            }
        }

        // Priority 4: Check if it's the current character
        if (this_chid !== undefined && characters && characters[this_chid]) {
            const currentChar = characters[this_chid];
            if (currentChar.name && currentChar.name.toLowerCase() === name.toLowerCase()) {
                return getSafeThumbnailUrl('avatar', currentChar.avatar);
            }
        }

        // No avatar found
        return null;
    }

    /**
     * Determines which character should narrate the combat summary
     * Priority: Narrator character > First active group member > Current character
     * @returns {string} Character name to use for /sendas
     */
    getCombatNarrator() {
        // Check if in group chat
        if (selected_group) {
            const group = groups.find(g => g.id === selected_group);
            const groupMembers = getGroupMembers(selected_group);

            if (groupMembers && groupMembers.length > 0) {
                const disabledMembers = group?.disabled_members || [];

                // First priority: Look for a character named "Narrator" or "GM"
                const narrator = groupMembers.find(member =>
                    member && member.name &&
                    !disabledMembers.includes(member.avatar) &&
                    (member.name.toLowerCase() === 'narrator' ||
                     member.name.toLowerCase() === 'gm' ||
                     member.name.toLowerCase() === 'game master')
                );

                if (narrator) {
                    return narrator.name;
                }

                // Second priority: First active (non-muted) group member
                const firstActive = groupMembers.find(member =>
                    member && member.name &&
                    !disabledMembers.includes(member.avatar)
                );

                if (firstActive) {
                    return firstActive.name;
                }
            }
        }

        // Fallback: Use current character
        if (this_chid !== undefined && characters && characters[this_chid]) {
            return characters[this_chid].name;
        }

        // Last resort: Generic narrator
        return 'Narrator';
    }

    /**
     * Apply environment-based visual styling to the modal
     * @param {object} styleNotes - Style information from the AI
     */
    applyEnvironmentStyling(styleNotes) {
        if (!styleNotes || typeof styleNotes !== 'object') return;

        const { environmentType, atmosphere, timeOfDay, weather } = styleNotes;

        // Apply environment attribute
        if (environmentType) {
            this.modal.setAttribute('data-environment', environmentType.toLowerCase());
        }

        // Apply atmosphere attribute
        if (atmosphere) {
            this.modal.setAttribute('data-atmosphere', atmosphere.toLowerCase());
        }

        // Apply time attribute
        if (timeOfDay) {
            this.modal.setAttribute('data-time', timeOfDay.toLowerCase());
        }

        // Apply weather attribute
        if (weather) {
            this.modal.setAttribute('data-weather', weather.toLowerCase());
        }

        // console.log('[RPG Companion] Applied environment styling:', styleNotes);
    }
}

export const encounterModal = new EncounterModal();

export function openEncounterModal() {
    encounterModal.open();
}
