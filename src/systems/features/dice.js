/**
 * Dice System Module
 * Handles dice rolling logic, display updates, and quick reply integration
 */

import {
    extensionSettings,
    pendingDiceRoll,
    setPendingDiceRoll
} from '../../core/state.js';
import { saveChatData } from '../../core/persistence.js';
import { i18n } from '../../core/i18n.js';
import { rollDice as rollDiceFaces } from '../mechanics/rules.js';
import { getQueuedRoll, getActiveRoll, clearDisplayedRoll, summarizeRoll } from '../mechanics/rollState.js';

/**
 * Rolls the dice and displays result.
 * Works with the DiceModal class for UI updates.
 * @param {DiceModal} diceModal - The DiceModal instance
 */
export async function rollDice(diceModal) {
    if (!diceModal) return;

    const count = parseInt(String($('#rpg-dice-count').val())) || 1;
    const sides = parseInt(String($('#rpg-dice-sides').val())) || 20;

    // Start rolling animation
    diceModal.startRolling();

    // Wait for animation (simulate rolling)
    await new Promise(resolve => setTimeout(resolve, 1200));

    // Execute /roll command
    const rollCommand = `/roll ${count}d${sides}`;
    const rollResult = await executeRollCommand(rollCommand);

    // Parse result
    const total = rollResult.total || 0;
    const rolls = rollResult.rolls || [];

    // Store result temporarily (not saved until "Save Roll" is clicked)
    setPendingDiceRoll({
        formula: `${count}d${sides}`,
        total: total,
        rolls: rolls,
        timestamp: Date.now()
    });

    // Show result
    diceModal.showResult(total, rolls);

    // Don't update sidebar display yet - only update when user clicks "Save Roll"
}

/**
 * Executes a /roll command and returns the result.
 * @param {string} command - The roll command (e.g., "/roll 2d20")
 * @returns {Promise<{total: number, rolls: Array<number>}>} The roll result
 */
export async function executeRollCommand(command) {
    const match = command.match(/(\d+)d(\d+)/);
    if (!match) {
        return { total: 0, rolls: [] };
    }
    const rolls = rollDiceFaces(parseInt(match[1]), parseInt(match[2]));
    return { total: rolls.reduce((sum, r) => sum + r, 0), rolls };
}

/**
 * Updates the "Last Roll" display: a roll queued for the next message, or the
 * roll attached to the latest user message. Both are per chat.
 */
export function updateDiceDisplay() {
    const $display = $('#rpg-dice-display');
    if (!extensionSettings.showDiceDisplay) {
        $display.hide();
        return;
    }
    $display.show();

    const queued = getQueuedRoll();
    const active = queued ? null : getActiveRoll();
    const label = `${(i18n.getTranslation('template.mainPanel.lastRoll') || 'Last Roll:').trim()} `;
    const noneValue = i18n.getTranslation('global.none') || 'None';

    if (queued) {
        const nextLabel = i18n.getTranslation('dice.nextMessage') || 'Next message';
        $('#rpg-last-roll-text').text(`${nextLabel}: ${summarizeRoll(queued)}`);
    } else if (active) {
        $('#rpg-last-roll-text').text(label + summarizeRoll(active));
    } else {
        $('#rpg-last-roll-text').text(label + noneValue);
    }
    $('#rpg-clear-dice').toggle(!!(queued || active));
}

/**
 * Clears the roll shown in the display (the queued one first).
 */
export function clearDiceRoll() {
    clearDisplayedRoll();
    saveChatData();
    updateDiceDisplay();
}

/**
 * Adds the Roll Dice quick reply button.
 */
export function addDiceQuickReply() {
    // Create quick reply button if Quick Replies exist
    if (window.quickReplyApi) {
        // Quick Reply API integration would go here
        // For now, the dice display in the sidebar serves as the button
    }
}
