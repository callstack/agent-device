import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  chronological,
  selectPropKindRequests,
  summarizeRenders,
} from './react-profile-renders.ts';
import { MEMO, rawProfile, repeat, type Render } from './react-profile-renders.fixtures.ts';

test('commits from several roots are read as one timeline', () => {
  const raw = rawProfile({ 1: ['A'], 2: ['B'] }, [
    [300, 20, [1], [[1, 1]]],
    [100, 30, [2], [[2, 1]]],
  ]);
  const { commits } = summarizeRenders(chronological(raw));
  assert.deepEqual(
    commits.map((commit) => [commit.atMs, commit.updaters[0]?.name]),
    [
      [0, 'B'],
      [200, 'A'],
    ],
  );
});

test('unrecorded change descriptions leave render causes empty rather than blaming the parent', () => {
  const raw = rawProfile({ 1: ['A'] }, [[0, 1, [], [[1, 1]]]]);
  raw.commits[0]!.changes = null;
  assert.deepEqual(summarizeRenders(raw).components[0]?.causes, {
    mount: 0,
    props: 0,
    state: 0,
    hooks: 0,
    context: 0,
    parent: 0,
  });
});

test('prop kinds are requested for the most recent instances of each props-driven component', () => {
  const rows = repeat(3, (i) => 10 + i);
  const elements: Record<number, [string, number?, number?]> = { 1: ['List'], 2: ['Header'] };
  for (const id of rows) elements[id] = ['Row', MEMO, 1];
  const raw = rawProfile(
    elements,
    [
      [
        0,
        10,
        [1],
        [
          [1, 1, [0, null, [0], null]],
          [2, 1, 'parent'],
          ...rows.map((id): Render => [id, 1, [0, [0], null, null]]),
        ],
      ],
    ],
    ['onPress'],
  );
  assert.deepEqual(selectPropKindRequests(raw), {
    '10': ['onPress'],
    '11': ['onPress'],
    '12': ['onPress'],
  });
  const { components } = summarizeRenders(raw, { '12': { onPress: 'function' } });
  assert.deepEqual(components.find((c) => c.name === 'Row')?.propKinds, { onPress: 'function' });
  assert.equal(components.find((c) => c.name === 'Header')?.causes.parent, 1);
});

test('a commit keeps every component that rendered in it', () => {
  const ids = repeat(20, (i) => 10 + i);
  const elements: Record<number, [string, number?, number?]> = {};
  for (const id of ids) elements[id] = [`Widget${id}`];
  const raw = rawProfile(elements, [[0, 40, [], ids.map((id): Render => [id, 1, 'parent'])]]);
  assert.equal(summarizeRenders(raw).commits[0]?.components.length, 20);
});

test('names and prop keys that differ only by control characters stay apart', () => {
  const raw = rawProfile(
    { 1: ['Row'], 2: ['Row\u0007'] },
    [
      [
        0,
        10,
        [],
        [
          [1, 1, [0, [0], null, null]],
          [2, 1, [0, [1], null, null]],
        ],
      ],
    ],
    ['id', 'id\u001b'],
  );
  assert.deepEqual(
    summarizeRenders(raw).components.map((entry) => [entry.name, entry.changedProps]),
    [
      ['Row', { id: 1 }],
      ['Row\u0007', { 'id\u001b': 1 }],
    ],
  );
});

test('edited profiles cannot render inherited component-kind keys', () => {
  const raw = rawProfile({ 1: ['Valid'], 2: ['Invalid'] }, [
    [
      0,
      2,
      [],
      [
        [1, 1],
        [2, 1],
      ],
    ],
  ]);
  raw.elements['2'] = JSON.parse('["Invalid","toString",0,0]');
  assert.deepEqual(
    summarizeRenders(raw).components.map(({ name, kind }) => [name, kind]),
    [['Valid', 'function']],
  );
});
