/**
 * Built-in class templates: ready-made level-1 builds for quick character
 * creation, made for the default Heroic power level (100 CP, AP guide 40).
 * On a lower power level they are trimmed to fit when applied (see
 * features/sheet.js partsWithClass). Skills only apply in chats that track
 * a skill of that name.
 *
 * Pure data. Costs are checked in tests/classes.test.mjs.
 */

export const BUILTIN_CLASSES = Object.freeze([
    {
        id: 'builtin-fighter',
        name: 'Fighter',
        description: 'Armoured front-liner: hits hard, takes hits, and can catch a second wind.',
        level: 1,
        attributes: { str: 16, dex: 12, con: 15 },
        skills: { athletics: 2 },
        bought: { pd: 3, ed: 1, hp: 16, ocv: 2 },
        resistances: {},
        strike: { name: 'Sword', damageType: 'slash', description: 'A plain cut with the sword.' },
        abilities: [
            { name: 'Power Attack', description: 'A heavy two-handed blow.', target: 'one-enemy', roll: 'attack',
                effects: [{ type: 'damage', dice: 5, damageType: 'slash', scaleWith: 'str' }] },
            { name: 'Shield Bash', description: 'Slams the shield into the foe to stagger them.', target: 'one-enemy', roll: 'attack',
                effects: [{ type: 'damage', dice: 2, damageType: 'blunt' }, { type: 'status', status: { name: 'Staggered', template: 'incapacitate', duration: 1, resistWith: 'con' } }] },
            { name: 'Second Wind', description: 'Grits teeth and pushes through the pain.', target: 'self', roll: 'automatic',
                effects: [{ type: 'heal', dice: 3 }], limitations: [{ id: 'charges', uses: 2 }] },
            { name: 'Defensive Stance', description: 'Shield up, feet set.', target: 'self', roll: 'automatic',
                effects: [{ type: 'status', status: { name: 'Guarded', template: 'modifier', stat: 'dcv', amount: 2, duration: 2 } }] }
        ]
    },
    {
        id: 'builtin-rogue',
        name: 'Rogue',
        description: 'Quick and slippery: strikes weak spots, poisons blades and vanishes in smoke.',
        level: 1,
        attributes: { str: 11, dex: 18, con: 12 },
        skills: { stealth: 3, lockpicking: 2 },
        bought: { pd: 1, hp: 16 },
        resistances: {},
        strike: { name: 'Dagger', damageType: 'pierce', description: 'A quick jab with a dagger.' },
        abilities: [
            { name: 'Backstab', description: 'Slips the blade between plates.', target: 'one-enemy', roll: 'attack',
                effects: [{ type: 'damage', dice: 3, damageType: 'pierce', scaleWith: 'dex' }], advantages: [{ id: 'armorPiercing' }] },
            { name: 'Poisoned Blade', description: 'A nick that keeps burning.', target: 'one-enemy', roll: 'attack',
                effects: [{ type: 'damage', dice: 1, damageType: 'pierce' }, { type: 'status', status: { name: 'Poisoned', template: 'overTime', dice: 2, damageType: 'poison', duration: 3 } }] },
            { name: 'Smoke Bomb', description: 'A puff of smoke, and they are somewhere else.', target: 'self', roll: 'automatic',
                effects: [{ type: 'status', status: { name: 'Hidden in smoke', template: 'modifier', stat: 'dcv', amount: 3, duration: 2 } }], limitations: [{ id: 'charges', uses: 3 }] },
            { name: 'Dirty Trick', description: 'Sand in the eyes, a kick to the knee.', target: 'one-enemy', roll: 'attack',
                effects: [{ type: 'damage', dice: 1, damageType: 'blunt' }, { type: 'status', status: { name: 'Blinded', template: 'modifier', stat: 'ocv', amount: -2, duration: 2 } }] }
        ]
    },
    {
        id: 'builtin-mage',
        name: 'Mage',
        description: 'Fragile spellcaster with a big bolt, a wave of frost and a protective ward.',
        level: 1,
        attributes: { str: 9, dex: 13, con: 12, int: 16 },
        skills: { arcana: 3 },
        bought: { ed: 3, end: 14, dcv: 1 },
        resistances: {},
        strike: { name: 'Staff', damageType: 'blunt', description: 'A whack with the staff.' },
        abilities: [
            { name: 'Fire Bolt', description: 'A streak of flame.', target: 'one-enemy', roll: 'attack',
                effects: [{ type: 'damage', dice: 8, damageType: 'fire' }] },
            { name: 'Frost Wave', description: 'A ring of biting cold.', target: 'all-enemies', roll: 'attack',
                effects: [{ type: 'damage', dice: 4, damageType: 'ice' }] },
            { name: 'Arcane Ward', description: 'A shimmering barrier.', target: 'self', roll: 'automatic',
                effects: [{ type: 'shield', amount: 15, duration: 3 }] }
        ]
    },
    {
        id: 'builtin-healer',
        name: 'Healer',
        description: 'Keeps the party standing: heals, blesses, purifies, and can still swing a mace.',
        level: 1,
        attributes: { str: 11, dex: 10, con: 15, wis: 17 },
        skills: { medicine: 3 },
        bought: { pd: 2, ed: 2, end: 10, hp: 10 },
        resistances: {},
        strike: { name: 'Mace', damageType: 'blunt', description: 'A blow with a flanged mace.' },
        abilities: [
            { name: 'Mend Wounds', description: 'Warm light closes cuts and bruises.', target: 'one-ally', roll: 'automatic',
                effects: [{ type: 'heal', dice: 4 }] },
            { name: 'Bless', description: 'A prayer that steadies every hand.', target: 'all-allies', roll: 'automatic',
                effects: [{ type: 'status', status: { name: 'Blessed', template: 'modifier', stat: 'ocv', amount: 2, duration: 3 } }] },
            { name: 'Purify', description: 'Washes away poison and curses.', target: 'one-ally', roll: 'automatic',
                effects: [{ type: 'cleanse', category: 'debuff' }, { type: 'cleanse', category: 'overTime' }] },
            { name: 'Smite', description: 'A mace blow carried by faith.', target: 'one-enemy', roll: 'attack',
                effects: [{ type: 'damage', dice: 4, damageType: 'blunt', scaleWith: 'str' }] },
            { name: 'Sacred Flame', description: 'Holy fire bursts around the healer.', target: 'all-enemies', roll: 'attack',
                effects: [{ type: 'damage', dice: 2, damageType: 'fire' }] }
        ]
    },
    {
        id: 'builtin-ranger',
        name: 'Ranger',
        description: 'Archer and tracker: precise shots from range, or a volley over the whole field.',
        level: 1,
        attributes: { str: 11, dex: 16, con: 13, wis: 12 },
        skills: { survival: 3, perception: 2 },
        bought: { ocv: 1, pd: 2, ed: 1, hp: 12 },
        resistances: {},
        strike: { name: 'Hunting Knife', damageType: 'slash', description: 'A swipe with a hunting knife.' },
        abilities: [
            { name: 'Aimed Shot', description: 'Draws, holds, and lets fly.', target: 'one-enemy', roll: 'attack',
                effects: [{ type: 'damage', dice: 6, damageType: 'pierce' }], advantages: [{ id: 'accurate', levels: 1 }] },
            { name: 'Volley', description: 'Arrows rain across the field.', target: 'all-enemies', roll: 'attack',
                effects: [{ type: 'damage', dice: 3, damageType: 'pierce' }] },
            { name: 'Pinning Shot', description: 'An arrow through the boot.', target: 'one-enemy', roll: 'attack',
                effects: [{ type: 'damage', dice: 1, damageType: 'pierce' }, { type: 'status', status: { name: 'Pinned', template: 'modifier', stat: 'dcv', amount: -3, duration: 2 } }] }
        ],
        items: [
            { name: 'Healing Herbs', description: 'A pouch of bitter leaves.', target: 'self', roll: 'automatic', quantity: 2,
                effects: [{ type: 'heal', dice: 2 }] }
        ]
    }
]);
