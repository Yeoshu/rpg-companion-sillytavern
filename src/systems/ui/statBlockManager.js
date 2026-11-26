/**
 * Popups for stored stat blocks: a JSON editor for one block, and a manager
 * listing this chat's characters and the global templates.
 */

import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../../../../popup.js';
import { i18n } from '../../core/i18n.js';
import { normalizeStatBlock } from '../mechanics/combat/catalog.js';
import { deriveValues } from '../mechanics/combat/costs.js';
import { describeAbility } from '../mechanics/combat/describe.js';
import { getCombatSettings } from '../features/sheet.js';
import {
    deleteChatBlock, deleteTemplate, getChatBlocks, getTemplates, restoreChatBlock, saveChatBlock, saveTemplate
} from '../features/npcStore.js';

function t(key, fallback) {
    return i18n.getTranslation(key) || fallback;
}

function esc(text) {
    return String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/**
 * Edits a stat block as JSON.
 * @returns {Promise<object|null>} the normalized block, or null if cancelled/invalid
 */
export async function editStatBlockJson(block, title = block?.name) {
    const { budget, points, adjusted, stored, storedKey, fromTemplate, template, ...plain } = block || {};
    const $editor = $(`
        <div class="rpg-combat-json-editor">
            <h3>${esc(title)}</h3>
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
    if (result !== POPUP_RESULT.AFFIRMATIVE) return null;
    try {
        const parsed = normalizeStatBlock(JSON.parse(String($editor.find('textarea').val())));
        if (!parsed) throw new Error(t('encounter.ui.invalidStatBlock', 'A stat block needs at least a name.'));
        return parsed;
    } catch (error) {
        toastr.error(esc(error.message), t('encounter.ui.invalidJson', 'That is not valid JSON'));
        return null;
    }
}

/** Lists this chat's characters and the templates, with edit / rest / delete. */
export async function openStatBlockManager() {
    const settings = getCombatSettings();
    const $root = $('<div class="rpg-sheet rpg-npc-manager"></div>');

    const row = (block, kind, key) => {
        const d = deriveValues(block, settings);
        const hp = settings.keepWounds && block.hp !== undefined && block.hp < d.maxHp ? `${block.hp}/${d.maxHp}` : `${d.maxHp}`;
        return `
            <div class="rpg-sheet-card" data-kind="${kind}" data-key="${esc(key)}">
                <div class="rpg-sheet-card-head">
                    <strong>${esc(block.sprite || '')} ${esc(block.name)} <small class="rpg-sheet-dim">· ${esc(t('sheet.level', 'Level'))} ${block.level} · ${esc(block.tier)}</small></strong>
                    <span class="rpg-sheet-card-actions">
                        <button type="button" class="menu_button" data-npc="edit" title="${esc(t('sheet.edit', 'Edit'))}"><i class="fa-solid fa-pen"></i></button>
                        ${kind === 'chat' && settings.keepWounds ? `<button type="button" class="menu_button" data-npc="rest" title="${esc(t('npc.rest', 'Restore HP and END'))}"><i class="fa-solid fa-bed"></i></button>` : ''}
                        ${kind === 'chat' ? `<button type="button" class="menu_button" data-npc="template" title="${esc(t('npc.makeTemplate', 'Also save as a template for any chat'))}"><i class="fa-solid fa-clone"></i></button>` : ''}
                        <button type="button" class="menu_button" data-npc="delete" title="${esc(t('sheet.delete', 'Delete'))}"><i class="fa-solid fa-trash"></i></button>
                    </span>
                </div>
                ${block.description ? `<div class="rpg-sheet-card-desc">${esc(block.description)}</div>` : ''}
                <div class="rpg-sheet-chips"><span class="rpg-sheet-chip">HP ${hp}</span><span class="rpg-sheet-chip">SPD ${d.spd}</span>${(block.aliases || []).length ? `<span class="rpg-sheet-chip">${esc(t('npc.aka', 'also'))}: ${esc(block.aliases.join(', '))}</span>` : ''}</div>
                <div class="rpg-sheet-card-summary">${block.abilities.map(a => `<div><strong>${esc(a.name)}</strong>: ${esc(describeAbility(a))}</div>`).join('')}</div>
            </div>`;
    };

    const render = () => {
        const chat = Object.entries(getChatBlocks());
        const templates = getTemplates();
        $root.html(`
            <h3><i class="fa-solid fa-users-viewfinder"></i> ${esc(t('npc.title', 'Recurring characters'))}</h3>
            <section class="rpg-sheet-section">
                <h4>${esc(t('npc.chat', 'In this chat'))} <small>${esc(settings.keepWounds ? t('npc.chatHint', 'named characters; they keep their wounds between fights') : t('npc.chatHintFresh', 'named characters; they start each fight at full health'))}</small></h4>
                <div class="rpg-sheet-cards">${chat.map(([key, b]) => row(b, 'chat', key)).join('') || `<div class="rpg-sheet-empty">${esc(t('npc.noneChat', 'None yet. After a fight you can save who took part.'))}</div>`}</div>
            </section>
            <section class="rpg-sheet-section">
                <h4>${esc(t('npc.templates', 'Templates'))} <small>${esc(t('npc.templatesHint', 'generic kinds of combatant, usable in any chat'))}</small></h4>
                <div class="rpg-sheet-cards">${templates.map(b => row(b, 'template', b.name)).join('') || `<div class="rpg-sheet-empty">${esc(t('npc.noneTemplates', 'None yet.'))}</div>`}</div>
            </section>`);
    };

    $root.on('click', '[data-npc]', async function () {
        const $card = $(this).closest('.rpg-sheet-card');
        const kind = $card.data('kind');
        const key = String($card.data('key'));
        const block = kind === 'chat' ? getChatBlocks()[key] : getTemplates().find(b => b.name === key);
        if (!block) return;
        const action = $(this).data('npc');
        if (action === 'edit') {
            const edited = await editStatBlockJson(block);
            if (!edited) return;
            if (kind === 'chat') {
                deleteChatBlock(key);
                saveChatBlock(edited, { hp: edited.hp, end: edited.end });
            } else {
                deleteTemplate(key);
                saveTemplate(edited);
            }
        } else if (action === 'rest') {
            restoreChatBlock(key);
        } else if (action === 'template') {
            saveTemplate(block);
            toastr.success(esc(block.name), t('npc.templateSaved', 'Saved as a template'));
        } else if (action === 'delete') {
            if (kind === 'chat') deleteChatBlock(key);
            else deleteTemplate(key);
        }
        render();
    });

    render();
    await callGenericPopup($root, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: t('global.close', 'Close') });
}
