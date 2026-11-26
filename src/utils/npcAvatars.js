/**
 * Where an NPC's picture comes from.
 *
 * - Generated or uploaded NPC avatars are kept with the chat
 *   (extensionSettings.chatNpcAvatars, saved in chat_metadata) or shared by
 *   every chat (extensionSettings.npcAvatars), per `npcAvatarScope`.
 *   Lookups read the chat's own first, then the shared ones.
 * - A character card's picture is only used for characters who are in this
 *   chat: the current character, or the group's members. Other imported
 *   cards with the same name are ignored unless `avatarsFromAllCards` is on.
 */

import { this_chid, characters } from '../../../../../../script.js';
import { selected_group, getGroupMembers } from '../../../../../group-chats.js';
import { extensionSettings } from '../core/state.js';

/**
 * Case-insensitive name match that tolerates "(title)" suffixes and a card
 * name contained as a whole word ("Seraphina" ~ "Seraphina the Guardian").
 */
export function namesMatch(cardName, aiName) {
    if (!cardName || !aiName) return false;

    if (cardName.toLowerCase() === aiName.toLowerCase()) return true;

    const stripParens = (s) => s.replace(/\s*\([^)]*\)/g, '').trim();
    const cardCore = stripParens(cardName).toLowerCase();
    const aiCore = stripParens(aiName).toLowerCase();
    if (cardCore === aiCore) return true;

    const escapedCardCore = cardCore.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wordBoundary = new RegExp(`\\b${escapedCardCore}\\b`);
    return wordBoundary.test(aiCore);
}

/** 'chat' (default) or 'global'. */
export function npcAvatarScope() {
    return extensionSettings.npcAvatarScope === 'global' ? 'global' : 'chat';
}

function chatMap() {
    if (!extensionSettings.chatNpcAvatars || typeof extensionSettings.chatNpcAvatars !== 'object') extensionSettings.chatNpcAvatars = {};
    return extensionSettings.chatNpcAvatars;
}

function globalMap() {
    if (!extensionSettings.npcAvatars || typeof extensionSettings.npcAvatars !== 'object') extensionSettings.npcAvatars = {};
    return extensionSettings.npcAvatars;
}

/** The generated or uploaded avatar for this name, or null. */
export function getNpcAvatar(name) {
    if (!name) return null;
    const own = extensionSettings.chatNpcAvatars?.[name];
    if (typeof own === 'string' && own) return own;
    const shared = extensionSettings.npcAvatars?.[name];
    return typeof shared === 'string' && shared ? shared : null;
}

/**
 * Stores an avatar where the scope setting says. The caller saves
 * (saveSettings, and saveChatData for the chat scope).
 */
export function setNpcAvatar(name, url) {
    if (!name || !url) return;
    if (npcAvatarScope() === 'chat') {
        chatMap()[name] = url;
    } else {
        globalMap()[name] = url;
        delete chatMap()[name];
    }
}

/** Removes the avatar for this name from both places. */
export function deleteNpcAvatar(name) {
    delete chatMap()[name];
    delete globalMap()[name];
}

/** Forgets every avatar shared across chats; returns how many there were. */
export function clearSharedNpcAvatars() {
    const n = Object.keys(globalMap()).length;
    extensionSettings.npcAvatars = {};
    return n;
}

/**
 * The character card for this name, but only if that character is part of
 * this chat (the current character or a member of the current group), or any
 * imported card when `avatarsFromAllCards` is on.
 * @returns {object|null} the card ({ name, avatar, ... })
 */
export function findCardInChat(name) {
    if (!name) return null;
    const usable = card => card && card.name && card.avatar && card.avatar !== 'none' && namesMatch(card.name, name);
    if (selected_group) {
        try {
            const member = (getGroupMembers(selected_group) || []).find(usable);
            if (member) return member;
        } catch {
            // Ignore group lookup issues.
        }
    } else if (this_chid !== undefined && usable(characters?.[this_chid])) {
        return characters[this_chid];
    }
    if (extensionSettings.avatarsFromAllCards && Array.isArray(characters)) {
        return characters.find(usable) || null;
    }
    return null;
}
