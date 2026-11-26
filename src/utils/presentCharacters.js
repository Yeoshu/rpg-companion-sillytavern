import {
    extensionSettings,
    lastGeneratedData,
    committedTrackerData,
    FALLBACK_AVATAR_DATA_URI
} from '../core/state.js';
import { getSafeThumbnailUrl } from './avatars.js';
import { findCardInChat, getNpcAvatar, namesMatch } from './npcAvatars.js';

export function stripBrackets(value) {
    if (typeof value !== 'string') return value;
    return value.replace(/^\[|\]$/g, '').trim();
}

export function extractFieldValue(fieldValue) {
    if (fieldValue && typeof fieldValue === 'object' && 'value' in fieldValue) {
        return fieldValue.value || '';
    }
    return fieldValue || '';
}

export function toSnakeCase(name) {
    return name
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '_')
        .replace(/^_+|_+$/g, '');
}

export { namesMatch };

export function isPresentCharactersEnabled() {
    return !!(
        extensionSettings.showCharacterThoughts
        || extensionSettings.showAlternatePresentCharactersPanel
        || extensionSettings.showThoughtsInChat
    );
}

export function getPresentCharactersTrackerData({ useCommittedFallback = true } = {}) {
    return lastGeneratedData.characterThoughts || (useCommittedFallback ? committedTrackerData.characterThoughts : null) || '';
}

export function parsePresentCharacters(characterThoughtsData, { enabledFields = [], enabledCharStats = [] } = {}) {
    if (!characterThoughtsData) {
        return [];
    }

    let presentCharacters = [];

    try {
        const parsed = typeof characterThoughtsData === 'string'
            ? JSON.parse(characterThoughtsData)
            : characterThoughtsData;

        const charactersArray = Array.isArray(parsed) ? parsed : (parsed.characters || []);

        if (charactersArray.length > 0) {
            presentCharacters = charactersArray.map(char => {
                const character = {
                    name: char.name,
                    emoji: char.emoji || '👤'
                };

                if (char.details) {
                    for (const field of enabledFields) {
                        if (char.details[field.name] !== undefined) {
                            character[field.name] = stripBrackets(char.details[field.name]);
                        } else {
                            const fieldKey = toSnakeCase(field.name);
                            if (char.details[fieldKey] !== undefined) {
                                character[field.name] = stripBrackets(char.details[fieldKey]);
                            }
                        }
                    }
                }

                for (const field of enabledFields) {
                    if (character[field.name] === undefined) {
                        const fieldKey = toSnakeCase(field.name);
                        if (char[fieldKey] !== undefined) {
                            character[field.name] = stripBrackets(char[fieldKey]);
                        }
                    }
                }

                if (char.Relationship) {
                    character.Relationship = stripBrackets(char.Relationship);
                } else if (char.relationship) {
                    character.Relationship = stripBrackets(char.relationship.status || char.relationship);
                }

                if (char.thoughts) {
                    character.ThoughtsContent = stripBrackets(char.thoughts.content || char.thoughts);
                }

                if (char.stats && enabledCharStats.length > 0) {
                    if (Array.isArray(char.stats)) {
                        for (const statObj of char.stats) {
                            if (statObj.name && statObj.value !== undefined) {
                                const matchingStat = enabledCharStats.find(s => s.name === statObj.name);
                                if (matchingStat) {
                                    character[statObj.name] = statObj.value;
                                }
                            }
                        }
                    } else {
                        for (const stat of enabledCharStats) {
                            if (char.stats[stat.name] !== undefined) {
                                character[stat.name] = char.stats[stat.name];
                            }
                        }
                    }
                }

                return character;
            });
        }
    } catch {
        // Fall back to the legacy text format below.
    }

    if (presentCharacters.length > 0 || typeof characterThoughtsData !== 'string') {
        return presentCharacters;
    }

    const lines = characterThoughtsData.split('\n');
    let currentCharacter = null;
    const thoughtsLabel = extensionSettings.trackerConfig?.presentCharacters?.thoughts?.name || 'Thoughts';

    for (const line of lines) {
        if (!line.trim()
            || line.includes('Present Characters')
            || line.includes('---')
            || line.trim().startsWith('```')
            || line.trim() === '- …'
            || line.includes('(Repeat the format')) {
            continue;
        }

        if (line.trim().startsWith('- ')) {
            const name = line.trim().substring(2).trim();

            if (name && name.toLowerCase() !== 'unavailable') {
                currentCharacter = { name };
                presentCharacters.push(currentCharacter);
            } else {
                currentCharacter = null;
            }
        } else if (line.trim().startsWith('Details:') && currentCharacter) {
            const detailsContent = line.substring(line.indexOf(':') + 1).trim();
            const parts = detailsContent.split('|').map(p => p.trim());

            if (parts.length > 0) {
                currentCharacter.emoji = parts[0];
            }

            for (let i = 0; i < enabledFields.length && i + 1 < parts.length; i++) {
                currentCharacter[enabledFields[i].name] = parts[i + 1];
            }
        } else if (line.trim().startsWith('Relationship:') && currentCharacter) {
            currentCharacter.Relationship = line.substring(line.indexOf(':') + 1).trim();
        } else if (line.trim().startsWith('Stats:') && currentCharacter && enabledCharStats.length > 0) {
            const statsContent = line.substring(line.indexOf(':') + 1).trim();
            const statParts = statsContent.split('|').map(p => p.trim());

            for (const statPart of statParts) {
                const statMatch = statPart.match(/^(.+?):\s*(\d+)%$/);
                if (statMatch) {
                    currentCharacter[statMatch[1].trim()] = parseInt(statMatch[2], 10);
                }
            }
        } else if (line.trim().startsWith(thoughtsLabel + ':') && currentCharacter) {
            currentCharacter.ThoughtsContent = line.substring(line.indexOf(':') + 1).trim();
        }
    }

    return presentCharacters;
}

export function resolvePresentCharacterPortrait(name) {
    if (!name) return FALLBACK_AVATAR_DATA_URI;
    const own = getNpcAvatar(name);
    if (own) return own;
    const card = findCardInChat(name);
    return (card && getSafeThumbnailUrl('avatar', card.avatar)) || FALLBACK_AVATAR_DATA_URI;
}
