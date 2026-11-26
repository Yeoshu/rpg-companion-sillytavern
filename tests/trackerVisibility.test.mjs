// Stats switched off in the Tracker Editor stay out of prompts. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { withoutDisabledCharacterStats, withoutDisabledStats } from '../src/utils/trackerVisibility.js';

const config = { customStats: [
    { id: 'health', name: 'Health', enabled: false },
    { id: 'satiety', name: 'Satiety', enabled: true },
    { id: 'energy', name: 'Energy', enabled: false }
] };

test('switched-off stats are dropped from the stats array', () => {
    const data = { stats: [{ id: 'health', name: 'Health', value: 80 }, { id: 'satiety', name: 'Satiety', value: 40 }, { id: 'energy', value: 10 }], status: { mood: '😐' } };
    const out = withoutDisabledStats(data, config);
    assert.deepEqual(out.stats.map(s => s.id), ['satiety']);
    assert.deepEqual(out.status, { mood: '😐' });
    assert.equal(data.stats.length, 3, 'the original is not changed');
});

test('flat keys, JSON strings and the old text format', () => {
    assert.deepEqual(Object.keys(withoutDisabledStats({ health: 80, satiety: 40, mood: 'x' }, config)), ['satiety', 'mood']);
    const json = withoutDisabledStats(JSON.stringify({ stats: [{ id: 'health', value: 1 }, { id: 'satiety', value: 2 }] }), config);
    assert.equal(typeof json, 'string');
    assert.deepEqual(JSON.parse(json).stats.map(s => s.id), ['satiety']);
    assert.equal(withoutDisabledStats('Health: 80%\nSatiety: 40%\nEnergy: 5%\nMood: fine', config), 'Satiety: 40%\nMood: fine');
});

test('nothing changes when every stat is on', () => {
    const data = { stats: [{ id: 'health', value: 80 }] };
    assert.equal(withoutDisabledStats(data, { customStats: [{ id: 'health', enabled: true }] }), data);
    assert.equal(withoutDisabledStats(data, undefined), data);
});

test('character stats: one switched off, or the whole section off', () => {
    const data = { characters: [{ name: 'Aqua', stats: [{ name: 'Health', value: 95 }, { name: 'Arousal', value: 5 }], thoughts: { content: 'hm' } }] };
    const one = withoutDisabledCharacterStats(data, { characterStats: { enabled: true, customStats: [{ id: 'health', name: 'Health', enabled: true }, { id: 'arousal', name: 'Arousal', enabled: false }] } });
    assert.deepEqual(one.characters[0].stats.map(s => s.name), ['Health']);
    const all = withoutDisabledCharacterStats(JSON.stringify(data), { characterStats: { enabled: false, customStats: [] } });
    assert.equal(JSON.parse(all).characters[0].stats, undefined);
    assert.equal(JSON.parse(all).characters[0].thoughts.content, 'hm');
    assert.equal(withoutDisabledCharacterStats(data, { characterStats: { enabled: true, customStats: [] } }), data);
});
