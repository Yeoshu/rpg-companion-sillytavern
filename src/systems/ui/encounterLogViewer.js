/**
 * Viewer for the combat logs kept in the current chat.
 */

import { callGenericPopup, POPUP_TYPE } from '../../../../../../popup.js';
import { i18n } from '../../core/i18n.js';
import { deleteEncounterRecord, getEncounterLogs } from '../features/combatAftermath.js';

function t(key, fallback) {
    return i18n.getTranslation(key) || fallback;
}

function esc(text) {
    return String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function download(record) {
    const blob = new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `combat-${new Date(record.timestamp).toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function openEncounterLogs() {
    const $root = $('<div class="rpg-sheet rpg-combat-logs"></div>');
    const render = () => {
        const logs = [...getEncounterLogs()].reverse();
        $root.html(`
            <h3><i class="fa-solid fa-scroll"></i> ${esc(t('logs.title', 'Combat logs in this chat'))}</h3>
            ${logs.length ? logs.map(log => `
                <div class="rpg-sheet-card" data-ts="${log.timestamp}">
                    <div class="rpg-sheet-card-head">
                        <strong>${esc(new Date(log.timestamp).toLocaleString())} · ${esc(log.result)}</strong>
                        <span class="rpg-sheet-card-actions">
                            <button type="button" class="menu_button" data-log="export" title="${esc(t('sheet.export', 'Export as a file'))}"><i class="fa-solid fa-file-export"></i></button>
                            <button type="button" class="menu_button" data-log="delete" title="${esc(t('sheet.delete', 'Delete'))}"><i class="fa-solid fa-trash"></i></button>
                        </span>
                    </div>
                    <div class="rpg-sheet-card-summary">${esc((log.combatants || []).map(c => `${c.name}${c.out ? ' (down)' : c.fled ? ' (fled)' : ''}`).join(', '))}</div>
                    ${log.environment ? `<div class="rpg-sheet-card-desc">${esc(log.environment)}</div>` : ''}
                    ${log.summary ? `<details><summary>${esc(t('logs.summary', 'Summary'))}</summary><div class="rpg-combat-logs-text">${esc(log.summary)}</div></details>` : ''}
                    <details><summary>${esc(t('logs.full', 'Full log'))} (${(log.lines || []).length})</summary><div class="rpg-combat-logs-text">${esc((log.lines || []).join('\n'))}</div></details>
                </div>`).join('') : `<div class="rpg-sheet-empty">${esc(t('logs.empty', 'No fights saved in this chat yet.'))}</div>`}
        `);
    };
    $root.on('click', '[data-log]', function () {
        const ts = Number($(this).closest('[data-ts]').data('ts'));
        const record = getEncounterLogs().find(l => l.timestamp === ts);
        if (!record) return;
        if ($(this).data('log') === 'export') download(record);
        else {
            deleteEncounterRecord(ts);
            render();
        }
    });
    render();
    await callGenericPopup($root, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: t('global.close', 'Close') });
}
