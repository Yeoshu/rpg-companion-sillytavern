// Quests: names, descriptions, steps. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeQuest, normalizeQuests, diffQuests, withoutCompleted, formatQuest, allStepsDone, recentQuestHistory, toStored
} from '../src/systems/mechanics/quests.js';

test('quests from any shape: old strings, {title}, locked wrappers, the new shape', () => {
    assert.deepEqual(normalizeQuest('Deliver the toads'), { name: 'Deliver the toads', description: '', steps: [] });
    assert.equal(normalizeQuest('None'), null);
    assert.equal(normalizeQuest(''), null);
    assert.deepEqual(normalizeQuest({ title: 'Find a bath' }), { name: 'Find a bath', description: '', steps: [] });
    assert.deepEqual(normalizeQuest({ value: { value: 'Locked one' }, locked: true }).name, 'Locked one');
    const q = normalizeQuest({ name: 'The Toad Tax', description: 'Deliver the toads to the Guild', steps: ['Catch three toads', { text: 'Reach Axel', done: true }, { text: '' }] });
    assert.deepEqual(q, { name: 'The Toad Tax', description: 'Deliver the toads to the Guild', steps: [{ text: 'Catch three toads', done: false }, { text: 'Reach Axel', done: true }] });
    assert.equal(normalizeQuest({ name: 'X', status: 'Completed' }).completed, true);
    assert.equal(normalizeQuest({ description: 'Only a description here' }).name, 'Only a description here');
});

test('lists are de-duplicated by name and main is never also optional', () => {
    const q = normalizeQuests({ main: { name: 'Toad Tax' }, optional: ['toad tax', { name: 'Bath' }, { name: 'BATH', description: 'dupe' }, 'None'] });
    assert.equal(q.main.name, 'Toad Tax');
    assert.deepEqual(q.optional.map(x => x.name), ['Bath']);
    assert.deepEqual(toStored({ main: null, optional: [] }), { main: 'None', optional: [] });
});

test('diff by name: rewording keeps a quest, a missing name is dropped, completed is reported', () => {
    const before = { main: { name: 'Toad Tax', description: 'Deliver toads' }, optional: [{ name: 'Bath' }, { name: 'Bread' }] };
    const after = {
        main: { name: 'toad tax', description: 'Deliver the toads to the Guild in Axel', steps: [{ text: 'Reach Axel', done: true }] },
        optional: [{ name: 'Bath', completed: true }, { name: 'Old Debts' }]
    };
    const d = diffQuests(before, after);
    assert.deepEqual(d.dropped.map(x => [x.kind, x.quest.name]), [['side', 'Bread']]);
    assert.deepEqual(d.completed.map(x => x.quest.name), ['Bath']);
    assert.deepEqual(d.added.map(x => x.quest.name), ['Old Debts']);
    assert.deepEqual(withoutCompleted(after).optional.map(x => x.name), ['Old Debts']);
});

test('formatting and helpers', () => {
    assert.equal(formatQuest({ name: 'Toad Tax', description: 'Deliver toads', steps: [{ text: 'catch', done: true }, { text: 'deliver' }] }), 'Toad Tax: Deliver toads [✓ catch; ☐ deliver]');
    assert.equal(formatQuest('Bath'), 'Bath');
    assert.ok(allStepsDone({ steps: [{ text: 'a', done: true }] }));
    assert.ok(!allStepsDone({ steps: [] }));
    const h = [{ name: 'Old', outcome: 'completed', at: 2 }, { name: 'New', outcome: 'abandoned', at: 18 }];
    assert.deepEqual(recentQuestHistory(h, 20, 10).map(x => x.name), ['New']);
});
