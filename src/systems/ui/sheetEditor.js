/**
 * Character sheet editor and ability builder (popups).
 *
 * The editor works on a copy of the character (attributes, skill levels,
 * level, combat sheet) and writes it back on Save. Numbers update live; the
 * layout is only rebuilt when something is added or removed.
 * See docs/COMBAT_DESIGN.md §1–§4, §7 and §10.
 */

import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../../../../popup.js';
import { i18n } from '../../core/i18n.js';
import { getAttributes, getSkills } from '../mechanics/character.js';
import { attributeRoll, formatTarget, formatModifier } from '../mechanics/rules.js';
import { normalizeProgression } from '../mechanics/progression.js';
import { extensionSettings } from '../../core/state.js';
import {
    ADVANTAGES, BUYABLE, CLEANSE_CATEGORIES, DAMAGE_TYPES, ELEMENTAL_TYPES, LIMITATIONS, MODIFIER_STATS,
    PHYSICAL_TYPES, POWER_PRESETS, RESISTANCES, STATUS_TEMPLATES, TARGETS, normalizeAbility, normalizeCombatSettings
} from '../mechanics/combat/catalog.js';
import { saveSettings } from '../../core/persistence.js';
import {
    abilityCost, abilityPoints, abilityPoolCost, apCap, deriveValues, scalingDice
} from '../mechanics/combat/costs.js';
import { describeAbility, describeTarget } from '../mechanics/combat/describe.js';
import {
    applyParts, buildPlayerStatBlock, carriedEntries, currentParts, deleteFromLibrary, downloadSnapshot,
    getCombatSettings, getLibrary, importToLibrary, itemStock, partsFromSnapshot, playerName, saveToLibrary,
    sheetPoints, snapshotFrom
} from '../features/sheet.js';
import { openStatBlockManager } from './statBlockManager.js';

function t(key, fallback) {
    return i18n.getTranslation(key) || fallback;
}

function esc(text) {
    return String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

const clone = v => JSON.parse(JSON.stringify(v));
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

const BUYABLE_HELP = {
    hp: 'Hit points: 20 + 2 × CON',
    end: 'Endurance, spent on abilities: 2 × CON',
    rec: 'END regained each turn: STR/5 + CON/5',
    ocv: 'Attack value: DEX/5',
    dcv: 'Defence value: DEX/5',
    pd: 'Physical defence (blunt, pierce, slash): STR/5',
    ed: 'Elemental defence: CON/5',
    spd: 'Actions per 12-segment turn: 1 + DEX/10'
};

const TEMPLATE_LABELS = {
    overTime: 'Over time (burn, poison, regeneration)',
    modifier: 'Stat modifier (buff, debuff)',
    incapacitate: 'Incapacitate (stun, sleep)',
    shield: 'Shield (absorbs damage)',
    taunt: 'Taunt (must target the user)',
    counter: 'Counter (strikes back when hit)'
};

const EFFECT_LABELS = {
    damage: 'Damage',
    heal: 'Heal',
    shield: 'Shield',
    status: 'Apply status',
    cleanse: 'Cleanse',
    restoreEnd: 'Restore END'
};

/* ===========================================================================
   Character sheet
   =========================================================================== */

/**
 * Opens the character sheet. Resolves true when saved.
 */
export async function openSheetEditor() {
    const attributes = getAttributes();
    const skills = getSkills();
    let work = currentParts();
    let settings = getCombatSettings();
    const progression = normalizeProgression(extensionSettings.progression);
    const $root = $('<div class="rpg-sheet"></div>');

    const render = () => {
        $root.html(`
            <div class="rpg-sheet-head">
                <h3><i class="fa-solid fa-id-card"></i> ${esc(playerName())}</h3>
                <span class="rpg-sheet-level">${esc(t('sheet.level', 'Level'))} ${work.level}</span>
            </div>
            <div class="rpg-sheet-points" data-out="points"></div>

            <section class="rpg-sheet-section">
                <h4>${esc(t('sheet.attributes', 'Attributes'))} <small>${progression.attributeCost} CP ${esc(t('sheet.perPoint', 'per point from 10'))}</small></h4>
                <div class="rpg-sheet-table">
                    ${attributes.map(a => `
                        <div class="rpg-sheet-row">
                            <span class="rpg-sheet-label">${esc(a.name)}</span>
                            <input type="number" class="text_pole rpg-sheet-num" data-attr="${esc(a.id)}" value="${work.attributes[a.id] ?? 10}" min="0" step="1">
                            <span class="rpg-sheet-dim" data-out="attr-roll-${esc(a.id)}"></span>
                            <span class="rpg-sheet-cost" data-out="attr-cost-${esc(a.id)}"></span>
                        </div>`).join('')}
                </div>
            </section>

            <section class="rpg-sheet-section">
                <h4>${esc(t('sheet.combatValues', 'Combat values'))} <small>${esc(t('sheet.combatValuesHint', 'derived from attributes; buy extra with CP'))}</small></h4>
                <div class="rpg-sheet-table rpg-sheet-derived">
                    <div class="rpg-sheet-row rpg-sheet-row-head">
                        <span></span><span>${esc(t('sheet.base', 'Base'))}</span><span>${esc(t('sheet.bought', 'Bought'))}</span><span>${esc(t('sheet.total', 'Total'))}</span><span>CP</span>
                    </div>
                    ${Object.entries(BUYABLE).map(([key, b]) => `
                        <div class="rpg-sheet-row" title="${esc(BUYABLE_HELP[key])}">
                            <span class="rpg-sheet-label">${esc(b.label)}</span>
                            <span class="rpg-sheet-dim" data-out="base-${key}"></span>
                            <input type="number" class="text_pole rpg-sheet-num" data-bought="${key}" value="${work.sheet.bought[key] || 0}" step="1" ${key === 'spd' ? 'min="0"' : ''}>
                            <strong data-out="total-${key}"></strong>
                            <span class="rpg-sheet-cost" data-out="bought-cost-${key}"></span>
                        </div>`).join('')}
                </div>
                <small class="rpg-sheet-note">${esc(t('sheet.costsNote', 'Costs per +1: HP and END ½, REC 2, OCV/DCV 5, PD/ED 3, SPD 10.'))}</small>
            </section>

            ${skills.length ? `
            <section class="rpg-sheet-section">
                <h4>${esc(t('sheet.skills', 'Skills'))} <small>${progression.skillCost} CP ${esc(t('sheet.perLevel', 'per level'))}</small></h4>
                <div class="rpg-sheet-table">
                    ${skills.map(s => `
                        <div class="rpg-sheet-row">
                            <span class="rpg-sheet-label">${esc(s.name)}</span>
                            <input type="number" class="text_pole rpg-sheet-num" data-skill="${esc(s.key)}" value="${work.skills[s.key] ?? 0}" min="0" step="1">
                            <span></span>
                            <span class="rpg-sheet-cost" data-out="skill-cost-${esc(s.key)}"></span>
                        </div>`).join('')}
                </div>
            </section>` : ''}

            <section class="rpg-sheet-section">
                <h4>${esc(t('sheet.resistances', 'Resistances and weaknesses'))} <small>${esc(t('sheet.resistancesHint', 'resistant ×½ (5 CP), immune ×0 (15 CP), weak ×1.5 (−5 CP)'))}</small></h4>
                <div class="rpg-sheet-resist">
                    ${[['physical', PHYSICAL_TYPES], ['elemental', ELEMENTAL_TYPES]].map(([group, types]) => `
                        <div class="rpg-sheet-resist-group">
                            <span class="rpg-sheet-dim">${esc(t(`sheet.${group}`, cap(group)))}</span>
                            ${types.map(type => `
                                <label class="rpg-sheet-resist-item">
                                    <span>${esc(cap(type))}</span>
                                    <select class="text_pole" data-resist="${type}">
                                        <option value="">—</option>
                                        ${Object.keys(RESISTANCES).map(k => `<option value="${k}" ${work.sheet.resistances[type] === k ? 'selected' : ''}>${esc(cap(k))}</option>`).join('')}
                                    </select>
                                </label>`).join('')}
                        </div>`).join('')}
                </div>
            </section>

            <section class="rpg-sheet-section">
                <h4><i class="fa-solid fa-lightbulb"></i> ${esc(t('sheet.glimmers', 'Glimmers'))} <small>${esc(t('sheet.glimmersHint', 'new abilities can spark in tough fights; glimmered ones come with their own points'))}</small></h4>
                <textarea class="text_pole rpg-sheet-glimmer-prefs" data-glimmer-prefs rows="2" maxlength="1000" placeholder="${esc(t('sheet.glimmerPrefsPlaceholder', 'What kind of abilities should this character develop? e.g. frost magic and protecting allies; nothing flashy. Leave empty to let them grow from what they already have.'))}">${esc(work.sheet.glimmerPreferences || '')}</textarea>
            </section>

            <section class="rpg-sheet-section">
                <h4>${esc(t('sheet.basicAttack', 'Basic attack'))} <small>${esc(t('sheet.basicAttackHint', 'free; its dice come from STR'))}</small></h4>
                <div class="rpg-sheet-strike">
                    <input type="text" class="text_pole" data-strike="name" value="${esc(work.sheet.strike?.name || 'Strike')}" maxlength="60" placeholder="Strike">
                    <select class="text_pole" data-strike="damageType">${DAMAGE_TYPES.map(d => `<option value="${d}" ${(work.sheet.strike?.damageType || 'blunt') === d ? 'selected' : ''}>${esc(cap(d))}</option>`).join('')}</select>
                    <span class="rpg-sheet-dim" data-out="strike-dice"></span>
                    <input type="text" class="text_pole rpg-sheet-strike-desc" data-strike="description" value="${esc(work.sheet.strike?.description || '')}" maxlength="500" placeholder="${esc(t('sheet.strikeDescription', 'Flavour (e.g. a jab with brass knuckles)'))}">
                </div>
            </section>

            <section class="rpg-sheet-section">
                <h4>${esc(t('sheet.abilities', 'Abilities'))}
                    <small>${esc(t('sheet.abilitiesHint', 'the most expensive costs full price, the others a fifth'))}</small></h4>
                <div class="rpg-sheet-cards">${work.sheet.abilities.map((a, i) => abilityCard(a, i, 'ability')).join('') || `<div class="rpg-sheet-empty">${esc(t('sheet.noAbilities', 'No abilities yet. Everyone can always Strike, Dodge, Recover and Flee.'))}</div>`}</div>
                <button type="button" class="menu_button rpg-sheet-add" data-action="sheet-add-ability"><i class="fa-solid fa-plus"></i> ${esc(t('sheet.newAbility', 'New ability'))}</button>
            </section>

            <section class="rpg-sheet-section">
                <h4>${esc(t('sheet.items', 'Items'))}
                    <small>${esc(t('sheet.itemsHint', 'free; linked to the inventory by name'))}</small></h4>
                <div class="rpg-sheet-cards">${work.sheet.items.map((a, i) => abilityCard(a, i, 'item')).join('') || `<div class="rpg-sheet-empty">${esc(t('sheet.noItems', 'No usable items yet.'))}</div>`}</div>
                <button type="button" class="menu_button rpg-sheet-add" data-action="sheet-add-item"><i class="fa-solid fa-plus"></i> ${esc(t('sheet.newItem', 'New item'))}</button>
            </section>

            <section class="rpg-sheet-section">
                <h4>${esc(t('sheet.library', 'Saved characters'))} <small>${esc(t('sheet.libraryHint', 'reuse this character in other chats'))}</small></h4>
                <div class="rpg-sheet-library-save">
                    <input type="text" class="text_pole" data-field="library-name" value="${esc(playerName())}" placeholder="${esc(t('sheet.name', 'Name'))}">
                    <button type="button" class="menu_button" data-action="library-save"><i class="fa-solid fa-floppy-disk"></i> ${esc(t('sheet.saveNew', 'Save as new'))}</button>
                    <button type="button" class="menu_button" data-action="library-import"><i class="fa-solid fa-file-import"></i> ${esc(t('sheet.import', 'Import'))}</button>
                    <button type="button" class="menu_button" data-action="npc-manager" title="${esc(t('npc.manageHint', 'Stored stat blocks of recurring characters'))}"><i class="fa-solid fa-users-viewfinder"></i> ${esc(t('npc.manage', 'Characters'))}</button>
                    <input type="file" accept=".json,application/json" data-field="library-file" hidden>
                </div>
                <div class="rpg-sheet-library">${libraryRows()}</div>
            </section>
        `);
        refresh();
    };

    function libraryRows() {
        const library = getLibrary();
        if (!library.length) return `<div class="rpg-sheet-empty">${esc(t('sheet.libraryEmpty', 'Nothing saved yet.'))}</div>`;
        return library.map(e => `
            <div class="rpg-sheet-library-row" data-id="${esc(e.id)}">
                <span class="rpg-sheet-label">${esc(e.name)} <small>· ${esc(t('sheet.level', 'Level'))} ${e.level} · ${(e.abilities || []).length} ${esc(t('sheet.abilitiesShort', 'abilities'))}</small></span>
                <button type="button" class="menu_button" data-action="library-load" title="${esc(t('sheet.load', 'Load into this chat (on Save)'))}"><i class="fa-solid fa-download"></i></button>
                <button type="button" class="menu_button" data-action="library-overwrite" title="${esc(t('sheet.overwrite', 'Overwrite with this character'))}"><i class="fa-solid fa-floppy-disk"></i></button>
                <button type="button" class="menu_button" data-action="library-export" title="${esc(t('sheet.export', 'Export as a file'))}"><i class="fa-solid fa-file-export"></i></button>
                <button type="button" class="menu_button" data-action="library-delete" title="${esc(t('sheet.delete', 'Delete'))}"><i class="fa-solid fa-trash"></i></button>
            </div>`).join('');
    }

    function abilityCard(a, i, kind) {
        const cost = abilityCost(a);
        const others = work.sheet.abilities.filter((_, j) => j !== i);
        const marginal = kind === 'ability' ? abilityPoints(a, others) : 0;
        const over = cost.ap > apCap(work.level, settings);
        let stock = '';
        if (kind === 'item') {
            const s = itemStock(a, carriedEntries());
            stock = a.unlimited
                ? `<span class="rpg-sheet-chip rpg-sheet-chip-ok"><i class="fa-solid fa-infinity"></i> ${esc(t('sheet.unlimited', 'unlimited'))}</span>`
                : s.linked
                ? `<span class="rpg-sheet-chip rpg-sheet-chip-ok" title="${esc(t('sheet.linkedHint', 'Quantity comes from the tracker inventory'))}"><i class="fa-solid fa-link"></i> ×${s.quantity} ${esc(t('sheet.inInventory', 'in inventory'))}</span>`
                : `<label class="rpg-sheet-chip" title="${esc(t('sheet.notLinkedHint', 'Not found in the On Person inventory; using this quantity'))}">× <input type="number" class="text_pole rpg-sheet-qty" data-qty="${i}" value="${a.quantity ?? 1}" min="0" step="1"></label>`;
        }
        return `
            <div class="rpg-sheet-card" data-kind="${kind}" data-index="${i}">
                <div class="rpg-sheet-card-head">
                    <strong>${a.glimmered ? `<i class="fa-solid fa-lightbulb rpg-sheet-glimmered" title="${esc(t('sheet.glimmeredHint', 'Found through a glimmer'))}"></i> ` : ''}${esc(a.name)}</strong>
                    <span class="rpg-sheet-card-actions">
                        <button type="button" class="menu_button" data-action="sheet-edit" title="${esc(t('sheet.edit', 'Edit'))}"><i class="fa-solid fa-pen"></i></button>
                        <button type="button" class="menu_button" data-action="sheet-duplicate" title="${esc(t('sheet.duplicate', 'Duplicate'))}"><i class="fa-solid fa-copy"></i></button>
                        <button type="button" class="menu_button" data-action="sheet-remove" title="${esc(t('sheet.delete', 'Delete'))}"><i class="fa-solid fa-trash"></i></button>
                    </span>
                </div>
                ${a.description ? `<div class="rpg-sheet-card-desc">${esc(a.description)}</div>` : ''}
                <div class="rpg-sheet-card-summary">${esc(describeAbility(a))}</div>
                <div class="rpg-sheet-chips">
                    <span class="rpg-sheet-chip${over ? ' rpg-sheet-chip-warn' : ''}" title="${over ? esc(t('sheet.overCap', 'Above the Active Point guide for this level')) : ''}">${cost.ap} AP${over ? ' ⚠' : ''}</span>
                    ${kind === 'ability' ? `<span class="rpg-sheet-chip">+${marginal} CP</span>` : ''}
                    ${cost.end && kind === 'ability' ? `<span class="rpg-sheet-chip">${cost.end} END</span>` : ''}
                    ${stock}
                </div>
            </div>`;
    }

    /** Updates every computed number without rebuilding inputs. */
    const refresh = () => {
        const p = sheetPoints(work);
        const block = buildPlayerStatBlock(work);
        const derived = deriveValues(block, settings);
        const base = deriveValues({ ...block, bought: {} }, settings);
        $root.find('[data-out="points"]').html(`
            <div class="rpg-sheet-points-main ${p.unspent < 0 ? 'rpg-sheet-over' : ''}">
                <strong>${p.unspent}</strong> ${esc(p.unspent < 0 ? t('sheet.overBudget', 'CP over budget') : t('sheet.unspent', 'CP unspent'))}
            </div>
            <div class="rpg-sheet-meter"><div style="width:${Math.max(0, Math.min(100, Math.round(p.total / Math.max(1, p.budget) * 100)))}%"></div></div>
            <div class="rpg-sheet-dim">
                ${p.total} / ${p.budget} ${esc(t('sheet.spent', 'spent'))} ·
                ${esc(t('sheet.attributesShort', 'attributes'))} ${p.attributes} · ${esc(t('sheet.skillsShort', 'skills'))} ${p.skills} ·
                ${esc(t('sheet.boughtShort', 'combat values'))} ${p.bought} · ${esc(t('sheet.abilitiesShort', 'abilities'))} ${p.abilities} · ${esc(t('sheet.resistShort', 'resistances'))} ${p.resistances}
            </div>
            <label class="rpg-sheet-dim rpg-sheet-power" title="${esc(t('sheet.powerHint', 'How strong characters start compared with the world (all chats; also in Settings → Character Sheet)'))}">
                ${esc(t('sheet.powerLevel', 'Power level'))}
                <select class="text_pole" data-field="power">
                    ${Object.entries(POWER_PRESETS).map(([id, preset]) => `<option value="${id}" ${settings.powerPreset === id ? 'selected' : ''}>${esc(t(`sheet.power.${id}`, preset.label))} (${preset.startingPool} CP)</option>`).join('')}
                    ${settings.powerPreset === 'custom' ? `<option value="custom" selected>${esc(t('sheet.power.custom', 'Custom'))} (${settings.startingPool} CP)</option>` : ''}
                </select>
            </label>
            <label class="rpg-sheet-dim rpg-sheet-bonus" title="${esc(t('sheet.bonusHint', 'Extra (or fewer) points on top of the level budget'))}">
                ${esc(t('sheet.budgetLine', 'Budget: {base} for level {level}').replace('{base}', p.base).replace('{level}', work.level))} +
                <input type="number" class="text_pole rpg-sheet-num" data-field="bonus" value="${p.bonus}" step="1"> ${esc(t('sheet.bonus', 'bonus'))}${p.glimmer ? ` + ${p.glimmer} ${esc(t('sheet.fromGlimmers', 'from glimmers'))}` : ''}
            </label>`);
        for (const a of attributes) {
            const v = Number(work.attributes[a.id] ?? 10);
            $root.find(`[data-out="attr-roll-${a.id}"]`).text(formatTarget(attributeRoll(v)));
            $root.find(`[data-out="attr-cost-${a.id}"]`).text(`${(v - 10) * progression.attributeCost} CP`);
        }
        for (const [key, b] of Object.entries(BUYABLE)) {
            const map = { hp: 'maxHp', end: 'maxEnd' };
            const k = map[key] || key;
            $root.find(`[data-out="base-${key}"]`).text(base[k]);
            $root.find(`[data-out="total-${key}"]`).text(derived[k]);
            const cost = Math.round(b.cost * (work.sheet.bought[key] || 0) * 10) / 10;
            $root.find(`[data-out="bought-cost-${key}"]`).text(cost ? `${cost} CP` : '');
        }
        const strikeDice = Math.max(1, derived.strDice);
        $root.find('[data-out="strike-dice"]').text(`${strikeDice}d6 (${t('builder.avg', 'average')} ${strikeDice * 3.5})`);
        for (const s of skills) {
            const v = Number(work.skills[s.key] ?? 0);
            $root.find(`[data-out="skill-cost-${s.key}"]`).text(v ? `${v * progression.skillCost} CP` : '');
        }
    };

    const rebuildPreservingScroll = () => {
        const $scroller = $root.closest('.popup-content, .popup-body');
        const top = $scroller.scrollTop();
        render();
        $scroller.scrollTop(top);
    };

    // --- Inputs -------------------------------------------------------------
    $root.on('input change', '[data-attr]', function () {
        work.attributes[$(this).data('attr')] = Math.max(0, Math.round(Number($(this).val()) || 0));
        refresh();
    });
    $root.on('input change', '[data-bought]', function () {
        const key = $(this).data('bought');
        const v = Math.round(Number($(this).val()) || 0);
        if (v) work.sheet.bought[key] = key === 'spd' ? Math.max(0, v) : v;
        else delete work.sheet.bought[key];
        refresh();
    });
    $root.on('input change', '[data-skill]', function () {
        work.skills[$(this).data('skill')] = Math.max(0, Math.round(Number($(this).val()) || 0));
        refresh();
    });
    $root.on('change', '[data-resist]', function () {
        const type = $(this).data('resist');
        const v = $(this).val();
        if (v) work.sheet.resistances[type] = v;
        else delete work.sheet.resistances[type];
        refresh();
    });
    $root.on('input change', '[data-glimmer-prefs]', function () {
        work.sheet.glimmerPreferences = String($(this).val() || '');
    });
    $root.on('input change', '[data-strike]', function () {
        work.sheet.strike = { ...(work.sheet.strike || {}), [$(this).data('strike')]: $(this).val() };
    });
    $root.on('change', '[data-field="power"]', function () {
        // A global setting: applies at once (the sheet itself is still saved with Save).
        extensionSettings.combat = normalizeCombatSettings({ ...getCombatSettings(), powerPreset: $(this).val() });
        saveSettings();
        settings = getCombatSettings();
        $(document).trigger('rpg:progressionChanged');
        render();
    });
    $root.on('change', '[data-field="bonus"]', function () {
        work.sheet.bonusPoints = Math.round(Number($(this).val()) || 0);
        refresh();
    });
    $root.on('input change', '[data-qty]', function () {
        const item = work.sheet.items[Number($(this).data('qty'))];
        if (item) item.quantity = Math.max(0, Math.round(Number($(this).val()) || 0));
    });

    // --- Abilities and items -----------------------------------------------
    const listFor = kind => (kind === 'item' ? work.sheet.items : work.sheet.abilities);

    $root.on('click', '[data-action="sheet-add-ability"], [data-action="sheet-add-item"]', async function () {
        const kind = $(this).data('action') === 'sheet-add-item' ? 'item' : 'ability';
        const result = await openAbilityBuilder(null, { kind, work });
        if (result) {
            listFor(kind).push(result);
            uniqueIds(listFor(kind));
            rebuildPreservingScroll();
        }
    });
    $root.on('click', '.rpg-sheet-card [data-action]', async function () {
        const $card = $(this).closest('.rpg-sheet-card');
        const kind = $card.data('kind');
        const i = Number($card.data('index'));
        const list = listFor(kind);
        const action = $(this).data('action');
        if (action === 'sheet-edit') {
            const result = await openAbilityBuilder(list[i], { kind, work, index: i });
            if (result) list[i] = result;
        } else if (action === 'sheet-duplicate') {
            const copy = clone(list[i]);
            copy.name = `${copy.name} (2)`;
            copy.id = '';
            list.splice(i + 1, 0, normalizeAbility(copy, { item: kind === 'item' }));
        } else if (action === 'sheet-remove') {
            list.splice(i, 1);
        }
        uniqueIds(list);
        rebuildPreservingScroll();
    });

    // --- Library -----------------------------------------------------------
    $root.on('click', '[data-action="library-save"]', function () {
        const name = String($root.find('[data-field="library-name"]').val() || '').trim() || playerName();
        saveToLibrary(name, work);
        toastr.success(esc(name), t('sheet.savedToLibrary', 'Saved to your characters'));
        $root.find('.rpg-sheet-library').html(libraryRows());
    });
    $root.on('click', '.rpg-sheet-library-row [data-action]', async function () {
        const id = $(this).closest('.rpg-sheet-library-row').data('id');
        const entry = getLibrary().find(e => e.id === id);
        if (!entry) return;
        const action = $(this).data('action');
        if (action === 'library-load') {
            const parts = partsFromSnapshot(entry);
            if (!parts) return;
            work = { ...parts, attributes: { ...work.attributes, ...parts.attributes }, skills: { ...work.skills, ...parts.skills } };
            toastr.info(t('sheet.loadedHint', 'Loaded into the sheet. Click Save to keep it in this chat.'), esc(entry.name));
            rebuildPreservingScroll();
        } else if (action === 'library-overwrite') {
            saveToLibrary(entry.name, work, entry.id);
            toastr.success(esc(entry.name), t('sheet.overwritten', 'Saved over'));
            $root.find('.rpg-sheet-library').html(libraryRows());
        } else if (action === 'library-export') {
            downloadSnapshot(entry);
        } else if (action === 'library-delete') {
            deleteFromLibrary(id);
            $root.find('.rpg-sheet-library').html(libraryRows());
        }
    });
    $root.on('click', '[data-action="npc-manager"]', () => openStatBlockManager());
    $root.on('click', '[data-action="library-import"]', () => $root.find('[data-field="library-file"]').trigger('click'));
    $root.on('change', '[data-field="library-file"]', async function () {
        const file = this.files?.[0];
        this.value = '';
        if (!file) return;
        try {
            const entry = importToLibrary(JSON.parse(await file.text()));
            if (!entry) throw new Error('not a character sheet');
            toastr.success(esc(entry.name), t('sheet.imported', 'Imported'));
            $root.find('.rpg-sheet-library').html(libraryRows());
        } catch (error) {
            toastr.error(esc(error.message), t('sheet.importFailed', 'Could not import that file'));
        }
    });

    render();
    const result = await callGenericPopup($root, POPUP_TYPE.CONFIRM, '', {
        okButton: t('sheet.save', 'Save'),
        cancelButton: t('global.cancel', 'Cancel'),
        wide: true,
        large: true,
        allowVerticalScrolling: true
    });
    if (result !== POPUP_RESULT.AFFIRMATIVE) return false;
    applyParts(work);
    return true;
}

function uniqueIds(list) {
    const seen = new Set();
    for (const a of list) {
        const base = a.id || a.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        let id = base;
        let n = 2;
        while (seen.has(id)) id = `${base}-${n++}`;
        a.id = id;
        seen.add(id);
    }
}

/** Exposed for the snapshot export button outside the editor. */
export function exportCurrentCharacter() {
    downloadSnapshot(snapshotFrom(currentParts()));
}

/* ===========================================================================
   Ability builder
   =========================================================================== */

const MOD_PARAMS = {
    lifesteal: { key: 'percent', label: '%', min: 1, max: 100, def: 50 },
    accurate: { key: 'levels', label: '+OCV', min: 1, max: 10, def: 1 },
    charges: { key: 'uses', label: 'uses', min: 1, max: 99, def: 1 }
};

const MOD_HELP = {
    armorPiercing: 'Halves the target\'s PD/ED (+½)',
    lifesteal: 'Heals the user for a share of the damage dealt',
    accurate: '+1 OCV per level with this ability (+¼ each)',
    noEnd: 'Costs no END to use (+½)',
    charges: 'Limited uses per fight instead of END (1: −1, 2–3: −¾, 4–8: −½, 9+: −¼)',
    doubleEnd: 'Costs twice the END (−½)',
    requiresRoll: 'Needs a skill roll to work; a failed roll wastes the phase (−½)',
    itemBased: 'Comes from a focus or item that can be lost or taken (−½)',
    slow: 'Goes off at the end of the segment, after everyone else (−¼)',
    separateTargets: 'Effects can have their own targets, each chosen separately (+¼ per effect with its own target; an effect hitting a whole side costs double)'
};

function newEffect(type) {
    switch (type) {
        case 'damage': return { type, dice: 2, flat: 0, damageType: 'blunt', scaleWith: 'none' };
        case 'heal': return { type, dice: 2, flat: 0 };
        case 'shield': return { type, amount: 10, duration: 3 };
        case 'status': return { type, status: { template: 'modifier', name: '', description: '', duration: 3, stat: 'ocv', amount: -2, dice: 1, damageType: 'fire', heal: false, resistWith: 'con', triggers: 1 } };
        case 'cleanse': return { type, category: 'debuff' };
        case 'restoreEnd': return { type, amount: 5 };
        default: return null;
    }
}

/** Builder state from an ability (fills in every field so switching templates keeps values). */
function toDraft(ability, kind) {
    const a = ability ? clone(ability) : {
        name: '', description: '', target: 'one-enemy', roll: 'attack',
        effects: [newEffect('damage')], advantages: [], limitations: []
    };
    if (!ability && kind === 'item') {
        a.target = 'self';
        a.roll = 'automatic';
        a.effects = [newEffect('heal')];
        a.quantity = 1;
    }
    for (const e of a.effects) {
        if (e.type === 'status') e.status = { ...newEffect('status').status, ...e.status };
    }
    const mods = {};
    for (const id of [...Object.keys(ADVANTAGES), ...Object.keys(LIMITATIONS)]) {
        const found = [...(a.advantages || []), ...(a.limitations || [])].find(m => m.id === id);
        mods[id] = { on: Boolean(found), ...(MOD_PARAMS[id] ? { [MOD_PARAMS[id].key]: found?.[MOD_PARAMS[id].key] ?? MOD_PARAMS[id].def } : {}) };
        if (id === 'requiresRoll') Object.assign(mods[id], { skill: found?.skill || '', attribute: found?.attribute || 'int' });
    }
    return { ...a, mods };
}

function fromDraft(draft, kind) {
    const pickMods = catalog => Object.keys(catalog)
        .filter(id => draft.mods[id]?.on)
        .map(id => {
            const { on, ...rest } = draft.mods[id];
            return { id, ...rest };
        });
    const separate = draft.mods.separateTargets?.on;
    const raw = {
        id: draft.id,
        name: draft.name,
        description: draft.description,
        target: draft.target,
        roll: draft.roll,
        effects: draft.effects.map(e => {
            const { target, ...rest } = e;
            return separate && target ? { ...rest, target } : rest;
        }),
        advantages: pickMods(ADVANTAGES),
        limitations: pickMods(LIMITATIONS)
    };
    if (kind === 'item') {
        raw.quantity = draft.quantity ?? 1;
        raw.unlimited = Boolean(draft.unlimited);
    }
    return normalizeAbility(raw, { item: kind === 'item' });
}

function setPath(obj, path, value) {
    const keys = path.split('.');
    let o = obj;
    for (const k of keys.slice(0, -1)) o = o[k];
    o[keys.at(-1)] = value;
}

/**
 * Opens the ability (or item) builder.
 * @param {object|null} ability - to edit, or null for a new one
 * @param {{kind: 'ability'|'item', work: object, index?: number}} context
 * @returns {Promise<object|null>} the normalized ability, or null if cancelled
 */
export async function openAbilityBuilder(ability, { kind = 'ability', work, index = -1 } = {}) {
    const attributes = getAttributes();
    const skills = getSkills();
    const settings = getCombatSettings();
    const level = work?.level || extensionSettings.level || 1;
    const draft = toDraft(ability, kind);
    const $root = $('<div class="rpg-builder"></div>');

    const opt = (value, label, selected) => `<option value="${esc(value)}" ${String(selected) === String(value) ? 'selected' : ''}>${esc(label)}</option>`;
    const num = (path, value, attrs = '') => `<input type="number" class="text_pole rpg-sheet-num" data-path="${path}" value="${esc(value)}" ${attrs}>`;
    const statOptions = (selected) => [
        ...MODIFIER_STATS.map(s => opt(s, s === 'damage' ? 'Damage dice' : s.toUpperCase(), selected)),
        ...attributes.map(a => opt(a.id, a.name, selected))
    ].join('');

    const effectFields = (e, i) => {
        const p = `effects.${i}`;
        switch (e.type) {
            case 'damage': return `
                ${num(`${p}.dice`, e.dice, 'min="0" max="50"')}<span>d6 +</span>${num(`${p}.flat`, e.flat, 'min="0"')}
                <select class="text_pole" data-path="${p}.damageType">${DAMAGE_TYPES.map(d => opt(d, cap(d), e.damageType)).join('')}</select>
                <label class="rpg-builder-inline" title="${esc(t('builder.scaleHint', 'Physical damage only: +1d6 per 5 points above 10 in that attribute, up to this effect\'s own dice'))}"><span>${esc(t('builder.scales', 'scales with'))}</span>
                    <select class="text_pole" data-path="${p}.scaleWith">${opt('none', t('builder.scaleNone', 'nothing'), e.scaleWith || 'none')}${opt('str', 'STR', e.scaleWith)}${opt('dex', 'DEX', e.scaleWith)}</select></label>`;
            case 'heal': return `${num(`${p}.dice`, e.dice, 'min="0" max="50"')}<span>d6 +</span>${num(`${p}.flat`, e.flat, 'min="0"')}`;
            case 'shield': return `<span>${esc(t('builder.absorbs', 'absorbs'))}</span>${num(`${p}.amount`, e.amount, 'min="1"')}<span>${esc(t('builder.for', 'for'))}</span>${num(`${p}.duration`, e.duration, 'min="1" max="20"')}<span>${esc(t('builder.phases', 'phases'))}</span>`;
            case 'cleanse': return `<select class="text_pole" data-path="${p}.category">${CLEANSE_CATEGORIES.map(c => opt(c, { overTime: 'Damage over time', debuff: 'Debuffs', buff: 'Buffs', incapacitate: 'Incapacitation' }[c], e.category)).join('')}</select>`;
            case 'restoreEnd': return `${num(`${p}.amount`, e.amount, 'min="1"')}<span>END</span>`;
            case 'status': {
                const s = e.status;
                const sp = `${p}.status`;
                let specific = '';
                if (s.template === 'overTime') {
                    specific = `${num(`${sp}.dice`, s.dice, 'min="1" max="20"')}<span>d6</span>
                        <label class="checkbox_label"><input type="checkbox" data-path="${sp}.heal" data-rerender ${s.heal ? 'checked' : ''}> ${esc(t('builder.healing', 'healing'))}</label>
                        ${s.heal ? '' : `<select class="text_pole" data-path="${sp}.damageType">${DAMAGE_TYPES.map(d => opt(d, cap(d), s.damageType)).join('')}</select>`}
                        <span>${esc(t('builder.perPhase', 'per phase'))}</span>`;
                } else if (s.template === 'modifier') {
                    specific = `<select class="text_pole" data-path="${sp}.stat">${statOptions(s.stat)}</select>${num(`${sp}.amount`, s.amount, 'min="-50" max="50"')}`;
                } else if (s.template === 'shield') {
                    specific = `<span>${esc(t('builder.absorbs', 'absorbs'))}</span>${num(`${sp}.amount`, s.amount, 'min="1"')}`;
                } else if (s.template === 'counter') {
                    specific = `<span>${esc(t('builder.strikesBack', 'strikes back for'))}</span>${num(`${sp}.dice`, s.dice, 'min="1" max="20"')}<span>d6</span>
                        <select class="text_pole" data-path="${sp}.damageType">${DAMAGE_TYPES.map(d => opt(d, cap(d), s.damageType)).join('')}</select>
                        <span>${esc(t('builder.upTo', 'up to'))}</span>${num(`${sp}.triggers`, s.triggers ?? 1, 'min="1" max="10"')}<span>${esc(t('builder.times', 'times'))},</span>`;
                }
                const resist = (s.template === 'incapacitate' || s.template === 'taunt') ? `
                    <span>${esc(t('builder.resistWith', 'resisted with'))}</span>
                    <select class="text_pole" data-path="${sp}.resistWith">${opt('', t('builder.noRoll', 'no roll'), s.resistWith)}${attributes.map(a => opt(a.id, a.name, s.resistWith)).join('')}</select>` : '';
                return `
                    <input type="text" class="text_pole rpg-builder-status-name" data-path="${sp}.name" value="${esc(s.name)}" placeholder="${esc(t('builder.statusName', 'Status name (e.g. Burning)'))}">
                    <select class="text_pole" data-path="${sp}.template" data-rerender>${STATUS_TEMPLATES.map(k => opt(k, TEMPLATE_LABELS[k], s.template)).join('')}</select>
                    <span class="rpg-builder-break"></span>
                    ${specific}
                    <span>${esc(t('builder.for', 'for'))}</span>${num(`${sp}.duration`, s.duration, 'min="1" max="20"')}<span>${esc(t('builder.phases', 'phases'))}</span>
                    ${resist}`;
            }
            default: return '';
        }
    };

    const modRow = (id, catalog) => {
        const m = draft.mods[id];
        const param = MOD_PARAMS[id];
        return `
            <label class="rpg-builder-mod" title="${esc(MOD_HELP[id] || '')}">
                <input type="checkbox" data-mod="${id}" ${m.on ? 'checked' : ''}>
                <span>${esc(catalog[id].label)}</span>
                ${param ? `<input type="number" class="text_pole rpg-sheet-num" data-mod-param="${id}" value="${m[param.key]}" min="${param.min}" max="${param.max}"><small>${esc(param.label)}</small>` : ''}
                ${id === 'requiresRoll' ? `
                    <select class="text_pole" data-mod-skill>${opt('', t('builder.noSkill', '(attribute only)'), m.skill)}${skills.map(s => opt(s.key, s.name, m.skill)).join('')}</select>
                    <select class="text_pole" data-mod-attr>${attributes.map(a => opt(a.id, a.name, m.attribute)).join('')}</select>` : ''}
            </label>`;
    };

    const render = () => {
        $root.html(`
            <h3><i class="fa-solid ${kind === 'item' ? 'fa-flask' : 'fa-wand-sparkles'}"></i> ${esc(ability ? t('builder.edit', 'Edit') : (kind === 'item' ? t('builder.newItem', 'New item') : t('builder.newAbility', 'New ability')))}</h3>
            <div class="rpg-builder-grid">
                <label><span>${esc(t('sheet.name', 'Name'))}</span><input type="text" class="text_pole" data-path="name" value="${esc(draft.name)}" placeholder="${esc(kind === 'item' ? 'Health Potion' : 'Fire Bolt')}"></label>
                <label><span>${esc(t('builder.target', 'Target'))}</span><select class="text_pole" data-path="target">${TARGETS.map(x => opt(x, cap(describeTarget(x)), draft.target)).join('')}</select></label>
                <label><span>${esc(t('builder.roll', 'Roll'))}</span><select class="text_pole" data-path="roll">${opt('attack', t('builder.attackRoll', 'Attack roll (vs DCV)'), draft.roll)}${opt('automatic', t('builder.automatic', 'Automatic'), draft.roll)}</select></label>
                ${kind === 'item' ? `<label><span>${esc(t('builder.quantity', 'Quantity'))}</span>${draft.unlimited ? `<span class="rpg-sheet-dim">∞</span>` : num('quantity', draft.quantity ?? 1, 'min="0"')}
                    <span class="checkbox_label rpg-builder-unlimited" title="${esc(t('builder.unlimitedHint', 'Never used up (e.g. a wand or a holy symbol); not counted in the inventory'))}"><input type="checkbox" data-path="unlimited" data-rerender ${draft.unlimited ? 'checked' : ''}> ${esc(t('builder.unlimited', 'Unlimited use'))}</span></label>` : ''}
                <label class="rpg-builder-wide"><span>${esc(t('builder.description', 'Description (flavour only)'))}</span><textarea class="text_pole" rows="2" data-path="description">${esc(draft.description)}</textarea></label>
            </div>

            <h4>${esc(t('builder.effects', 'Effects'))}</h4>
            <div class="rpg-builder-effects">
                ${draft.effects.map((e, i) => `
                    <div class="rpg-builder-effect" data-index="${i}">
                        <strong>${esc(EFFECT_LABELS[e.type])}</strong>
                        ${draft.mods.separateTargets.on ? `
                            <label class="rpg-builder-inline" title="${esc(t('builder.effectTargetHint', 'Leave on the main target, or give this effect its own target (chosen separately when used)'))}"><span>→</span>
                                <select class="text_pole" data-path="effects.${i}.target" data-rerender>${opt('', t('builder.mainTarget', 'main target'), e.target || '')}${TARGETS.map(x => opt(x, describeTarget(x), e.target || '')).join('')}</select></label>
                            <span class="rpg-builder-break"></span>` : ''}
                        ${effectFields(e, i)}
                        <button type="button" class="menu_button rpg-builder-remove" data-action="builder-remove-effect" title="${esc(t('sheet.delete', 'Delete'))}"><i class="fa-solid fa-xmark"></i></button>
                    </div>`).join('')}
            </div>
            <div class="rpg-builder-add">
                <select class="text_pole" data-field="new-effect">${Object.entries(EFFECT_LABELS).map(([k, l]) => opt(k, l, 'damage')).join('')}</select>
                <button type="button" class="menu_button" data-action="builder-add-effect"><i class="fa-solid fa-plus"></i> ${esc(t('builder.addEffect', 'Add effect'))}</button>
            </div>

            <div class="rpg-builder-mods">
                <div><h4>${esc(t('builder.advantages', 'Advantages'))} <small>${esc(t('builder.advantagesHint', 'raise the cost'))}</small></h4>${Object.keys(ADVANTAGES).map(id => modRow(id, ADVANTAGES)).join('')}</div>
                <div><h4>${esc(t('builder.limitations', 'Limitations'))} <small>${esc(t('builder.limitationsHint', 'lower the price'))}</small></h4>${Object.keys(LIMITATIONS).map(id => modRow(id, LIMITATIONS)).join('')}</div>
            </div>

            <div class="rpg-builder-readout" data-out="readout"></div>
        `);
        refresh();
    };

    const current = () => fromDraft(draft, kind);

    const refresh = () => {
        const a = current();
        const $out = $root.find('[data-out="readout"]');
        if (!a) {
            $out.html(`<span class="rpg-sheet-dim">${esc(t('builder.incomplete', 'Give it a name and at least one effect.'))}</span>`);
            return;
        }
        const cost = abilityCost(a);
        const limit = apCap(level, settings);
        const others = (work?.sheet.abilities || []).filter((_, j) => j !== index);
        const cp = kind === 'item' ? null : abilityPoints(a, others);
        const pool = kind === 'item' ? 0 : abilityPoolCost([...others, a]);
        $out.html(`
            <div class="rpg-builder-costs">
                <span><strong>${cost.ap}</strong> AP</span>
                <span><strong>${cost.real}</strong> ${esc(t('builder.realCost', 'real cost'))}</span>
                ${kind === 'item'
                    ? `<span>${esc(t('builder.itemsFree', 'Items cost no CP'))}</span>`
                    : `<span title="${esc(t('builder.marginalHint', 'What adding this ability costs this sheet (abilities are priced as a pool)'))}"><strong>+${cp}</strong> CP ${esc(t('builder.forSheet', 'for this sheet'))} <small>(${esc(t('builder.allAbilities', 'all abilities'))}: ${pool})</small></span>`}
                ${kind === 'item' ? '' : `<span><strong>${cost.end}</strong> END</span>`}
            </div>
            ${cost.ap > limit ? `<div class="rpg-builder-warn"><i class="fa-solid fa-triangle-exclamation"></i> ${esc(t('builder.overCap', 'Above the guide of {cap} AP for level {level}. Allowed, but strong for this level.').replace('{cap}', limit).replace('{level}', level))}</div>` : ''}
            <div class="rpg-builder-summary">${esc(describeAbility(a))}</div>
            ${compareWithStrike(a)}`);
    };

    /** "Average damage 17.5 · your Strike: 3d6 blunt, 10.5" (before defences). */
    const compareWithStrike = (a) => {
        const values = deriveValues(buildPlayerStatBlock(work || {}), settings);
        const strike = work?.sheet?.strike || {};
        const strikeDice = Math.max(1, values.strDice);
        const damage = a.effects.filter(e => e.type === 'damage');
        const avg = damage.reduce((sum, e) => sum + (e.dice + scalingDice(values, e)) * 3.5 + e.flat, 0);
        return `<div class="rpg-builder-compare">
            ${damage.length ? `<span>${esc(t('builder.avgDamage', 'Average damage'))}: <strong>${avg}</strong></span>` : ''}
            <span>${esc(t('builder.yourStrike', 'Your {name}').replace('{name}', strike.name || 'Strike'))}: ${strikeDice}d6 ${esc(strike.damageType || 'blunt')}, ${esc(t('builder.avg', 'average'))} ${strikeDice * 3.5}</span>
            <small class="rpg-sheet-dim">${esc(t('builder.beforeDefences', 'all damage effects, before defences; area effects per target'))}</small>
        </div>`;
    };

    // Inputs bound to the draft by path.
    $root.on('input change', '[data-path]', function (e) {
        const path = $(this).data('path');
        let value;
        if (this.type === 'checkbox') value = this.checked;
        else if (this.type === 'number') value = Number($(this).val());
        else value = $(this).val();
        setPath(draft, path, value);
        if (this.hasAttribute('data-rerender') && e.type === 'change') render();
        else refresh();
    });
    $root.on('change', '[data-mod]', function () {
        const id = $(this).data('mod');
        draft.mods[id].on = this.checked;
        if (id === 'separateTargets') render();
        else refresh();
    });
    $root.on('input change', '[data-mod-param]', function () {
        const id = $(this).data('mod-param');
        draft.mods[id][MOD_PARAMS[id].key] = Number($(this).val());
        refresh();
    });
    $root.on('change', '[data-mod-skill]', function () { draft.mods.requiresRoll.skill = $(this).val(); refresh(); });
    $root.on('change', '[data-mod-attr]', function () { draft.mods.requiresRoll.attribute = $(this).val(); refresh(); });
    $root.on('click', '[data-action="builder-add-effect"]', () => {
        draft.effects.push(newEffect($root.find('[data-field="new-effect"]').val()));
        render();
    });
    $root.on('click', '[data-action="builder-remove-effect"]', function () {
        draft.effects.splice(Number($(this).closest('.rpg-builder-effect').data('index')), 1);
        render();
    });

    render();
    while (true) {
        const result = await callGenericPopup($root, POPUP_TYPE.CONFIRM, '', {
            okButton: t('builder.done', 'Done'),
            cancelButton: t('global.cancel', 'Cancel'),
            wide: true,
            allowVerticalScrolling: true,
            // Keep the builder open when Done is clicked on an incomplete ability.
            onClosing: (popup) => {
                if (popup.result !== POPUP_RESULT.AFFIRMATIVE || current()) return true;
                toastr.warning(t('builder.incomplete', 'Give it a name and at least one effect.'));
                return false;
            }
        });
        if (result !== POPUP_RESULT.AFFIRMATIVE) return null;
        const a = current();
        if (a) return a;
        toastr.warning(t('builder.incomplete', 'Give it a name and at least one effect.'));
    }
}
