import { test } from 'vitest';
import assert from 'node:assert/strict';
import { analyzeReactProfile } from './react-profile-analysis.ts';
import { selectPropKindRequests, type RawReactProfile } from './react-profile-renders.ts';
import {
  FUNCTION,
  MEMO,
  rawProfile,
  repeat,
  type Render,
} from './react-profile-renders.fixtures.ts';

const kinds = (raw: RawReactProfile) =>
  analyzeReactProfile(raw).findings.map((f) => `${f.kind} ${f.component}`);

test('a component whose own render is slow is reported with its per-render cost', () => {
  const raw = rawProfile(
    { 1: ['Screen'], 2: ['Chart', FUNCTION, 1] },
    repeat(4, (i) => [
      i * 200,
      60,
      [1],
      [
        [1, 1, [0, null, [0], null]],
        [2, 55],
      ],
    ]),
  );
  const [finding] = analyzeReactProfile(raw).findings;
  assert.equal(finding?.kind, 'slow-render');
  assert.equal(finding?.component, 'Chart');
  assert.match(finding?.evidence ?? '', /^55ms per render/);
});

test('memo bypassed by props that change on every render names the props, their kinds, and the owner', () => {
  const rows = repeat(20, (i) => 10 + i);
  const elements: Record<number, [string, number?, number?]> = { 1: ['List'] };
  for (const id of rows) elements[id] = ['Memo(Row)', MEMO, 1];
  const raw = rawProfile(
    elements,
    repeat(3, (i) => [
      i * 200,
      30,
      [1],
      [[1, 1, [0, null, [0], null]], ...rows.map((id): Render => [id, 1, [0, [0, 1], null, null]])],
    ]),
    ['onPress', 'style'],
  );

  const request = selectPropKindRequests(raw);
  assert.deepEqual(
    new Set(Object.values(request).map((keys) => keys.join())),
    new Set(['onPress,style']),
  );
  const [id] = Object.keys(request);
  const [finding] = analyzeReactProfile(raw, {
    [id!]: { onPress: 'function', style: 'object' },
  }).findings;
  assert.equal(finding?.kind, 'memo-defeated');
  assert.equal(finding?.component, 'Row');
  assert.match(
    finding?.evidence ?? '',
    /new onPress \(function\) 60x, style \(object\) 60x from List/,
  );
});

test('a memoized component re-rendering on real value changes is not memo-defeated', () => {
  const rows = repeat(12, (i) => 10 + i);
  const elements: Record<number, [string, number?, number?]> = { 1: ['List'] };
  for (const id of rows) elements[id] = ['Row', MEMO, 1];
  const raw = rawProfile(
    elements,
    repeat(3, (i) => [
      i * 200,
      30,
      [1],
      [[1, 1, [0, null, [0], null]], ...rows.map((id): Render => [id, 2, [0, [0], null, null]])],
    ]),
    ['selected'],
  );
  const [id] = Object.keys(selectPropKindRequests(raw));
  assert.deepEqual(analyzeReactProfile(raw, { [id!]: { selected: 'boolean' } }).findings, []);
});

test('renders forced only by a parent re-render point at the owner to memoize below', () => {
  const rows = repeat(15, (i) => 10 + i);
  const elements: Record<number, [string, number?, number?]> = { 1: ['Search'] };
  for (const id of rows) elements[id] = ['ResultRow', FUNCTION, 1];
  const raw = rawProfile(
    elements,
    repeat(4, (i) => [
      i * 100,
      20,
      [1],
      [[1, 1, [0, null, [0], null]], ...rows.map((id): Render => [id, 1, 'parent'])],
    ]),
  );

  assert.deepEqual(kinds(raw), ['parent-cascade ResultRow']);
  assert.match(
    analyzeReactProfile(raw).findings[0]!.evidence,
    /when Search rendered across 15 instances/,
  );
});

test('a cascade of moderately slow rows is reported as the cascade, not as slow renders', () => {
  const rows = repeat(30, (i) => 10 + i);
  const elements: Record<number, [string, number?, number?]> = { 1: ['Search'] };
  for (const id of rows) elements[id] = ['ResultRow', FUNCTION, 1];
  const raw = rawProfile(
    elements,
    repeat(4, (i) => [
      i * 300,
      200,
      [1],
      [[1, 1, [0, null, [0], null]], ...rows.map((id): Render => [id, 5, 'parent'])],
    ]),
  );
  assert.deepEqual(kinds(raw), ['parent-cascade ResultRow']);
});

test('context-driven renders are traced to the component whose update changed the context', () => {
  const badges = repeat(12, (i) => 10 + i);
  const elements: Record<number, [string, number?, number?]> = { 1: ['SessionProvider'] };
  for (const id of badges) elements[id] = ['Badge', FUNCTION, 1];
  const raw = rawProfile(
    elements,
    repeat(3, (i) => [
      i * 100,
      25,
      [1],
      [[1, 1, [0, null, [0], null]], ...badges.map((id): Render => [id, 2, [1, null, null, null]])],
    ]),
  );

  const [finding] = analyzeReactProfile(raw).findings;
  assert.equal(finding?.kind, 'context-cascade');
  assert.match(
    finding?.evidence ?? '',
    /36 context-driven renders across 12 instances after updates in SessionProvider/,
  );
});

test('a state update set right after the previous commit is reported as an effect chain', () => {
  const raw = rawProfile(
    { 1: ['Screen'], 2: ['Filtered', FUNCTION, 1] },
    repeat(4, (i) => i).flatMap((i): Array<[number, number, number[], Render[]]> => [
      [
        i * 200,
        10,
        [1],
        [
          [1, 1, [0, null, [0], null]],
          [2, 5],
        ],
      ],
      [i * 200 + 12, 10, [2], [[2, 9, [0, null, [0], null]]]],
    ]),
  );
  assert.ok(kinds(raw).includes('effect-chain Filtered'));
});

test('a follow-up commit counts once per component however many of its instances triggered it', () => {
  const raw = rawProfile(
    {
      1: ['Screen'],
      2: ['Filtered', FUNCTION, 1],
      3: ['Filtered', FUNCTION, 1],
      4: ['Filtered', FUNCTION, 1],
    },
    repeat(3, (i) => i).flatMap((i): Array<[number, number, number[], Render[]]> => [
      [
        i * 300,
        10,
        [1],
        [
          [1, 1, [0, null, [0], null]],
          [2, 2],
          [3, 2],
          [4, 2],
        ],
      ],
      [
        i * 300 + 12,
        10,
        [2, 3, 4],
        [
          [2, 3, [0, null, [0], null]],
          [3, 3, [0, null, [0], null]],
          [4, 3, [0, null, [0], null]],
        ],
      ],
    ]),
  );
  const chain = analyzeReactProfile(raw).findings.find(
    (finding) => finding.kind === 'effect-chain',
  );
  assert.match(
    chain?.evidence ?? '',
    /^3 follow-up commits it triggered right after rendering, likely state set in an effect \(30ms\)$/,
  );
});

test('without inspected value kinds a memo bypass names the changed props without claiming new identities', () => {
  const rows = repeat(12, (i) => 10 + i);
  const elements: Record<number, [string, number?, number?]> = { 1: ['List'] };
  for (const id of rows) elements[id] = ['Row', MEMO, 1];
  const raw = rawProfile(
    elements,
    repeat(3, (i) => [
      i * 200,
      30,
      [1],
      [[1, 1, [0, null, [0], null]], ...rows.map((id): Render => [id, 2, [0, [0], null, null]])],
    ]),
    ['onPress'],
  );
  const [finding] = analyzeReactProfile(raw).findings;
  assert.equal(
    finding?.evidence,
    'memo bypassed on 36/36 updates; changed onPress 36x from List (value kinds not inspected)',
  );
});

test('every large mount group in a commit is its own eager-mount finding', () => {
  const tiles = repeat(220, (i) => 10 + i);
  const rows = repeat(210, (i) => 1000 + i);
  const elements: Record<number, [string, number?, number?]> = { 1: ['Catalog'] };
  for (const id of tiles) elements[id] = ['Tile', FUNCTION, 1];
  for (const id of rows) elements[id] = ['Row', FUNCTION, 1];
  const raw = rawProfile(elements, [
    [
      0,
      400,
      [1],
      [
        [1, 5, [0, null, [0], null]],
        ...tiles.map((id): Render => [id, 1, 1]),
        ...rows.map((id): Render => [id, 1, 1]),
      ],
    ],
  ]);
  assert.deepEqual(kinds(raw).sort(), ['eager-mount Row', 'eager-mount Tile']);
  const costs = Object.fromEntries(
    analyzeReactProfile(raw).findings.map((finding) => [finding.component, finding.costMs]),
  );
  assert.deepEqual(costs, { Tile: 220, Row: 210 });
});

test('many commits from one updater in a short span are a render storm', () => {
  const raw = rawProfile(
    { 1: ['Clock'] },
    repeat(40, (i) => [i * 16, 0.5, [1], [[1, 0.4, [0, null, [0], null]]]]),
  );
  const [finding] = analyzeReactProfile(raw).findings;
  assert.equal(finding?.kind, 'render-storm');
  assert.match(finding?.evidence ?? '', /^40 commits in 0\.6s \(63\/s, 20ms rendering\)$/);
});

test('mounting hundreds of one component in a commit is an eager list, reported once per component', () => {
  const tiles = repeat(250, (i) => 10 + i);
  const elements: Record<number, [string, number?, number?]> = { 1: ['Catalog'] };
  for (const id of tiles) elements[id] = ['Tile', FUNCTION, 1];
  const raw = rawProfile(elements, [
    [0, 300, [1], [[1, 5, [0, null, [0], null]], ...tiles.map((id): Render => [id, 1, 1, 1.1])]],
  ]);

  assert.deepEqual(kinds(raw), ['eager-mount Tile']);
});

test('a component mounted eagerly in several commits is one finding costed across them', () => {
  const tiles = repeat(250, (i) => 10 + i);
  const elements: Record<number, [string, number?, number?]> = { 1: ['Catalog'] };
  for (const id of tiles) elements[id] = ['Tile', FUNCTION, 1];
  const mount = (at: number, duration: number): [number, number, number[], Render[]] => [
    at,
    duration,
    [1],
    [[1, 5, [0, null, [0], null]], ...tiles.map((id): Render => [id, 1, 1, duration / 300])],
  ];
  const [finding, ...rest] = analyzeReactProfile(
    rawProfile(elements, [mount(0, 300), mount(1_000, 600)]),
  ).findings;

  assert.equal(finding?.kind, 'eager-mount');
  assert.equal(rest.length, 0);
  assert.equal(Math.round(finding!.costMs), 750);
  assert.match(
    finding!.evidence,
    /^250 instances mounted at once in commit #1, 500ms of its 600ms/,
  );
  assert.match(finding!.evidence, /; 2 such commits, 750ms in all$/);
});

test('an Animated wrapper stays a framework component instead of merging into the one it wraps', () => {
  const rows = repeat(30, (i) => 10 + i);
  const elements: Record<number, [string, number?, number?]> = { 1: ['Screen'] };
  for (const id of rows) elements[id] = ['Animated(Row)', FUNCTION, 1];
  const raw = rawProfile(
    elements,
    repeat(5, (i) => [
      i * 100,
      20,
      [1],
      [[1, 1, [0, null, [0], null]], ...rows.map((id): Render => [id, 1, 'parent'])],
    ]),
  );

  assert.deepEqual(kinds(raw), []);
  assert.deepEqual(
    analyzeReactProfile(raw).components.map((c) => c.name),
    ['Animated(Row)', 'Screen'],
  );
});

test('renders of elements the profile could not name stay out of components and findings', () => {
  const unnamed = repeat(30, (i) => 10 + i);
  const raw = rawProfile(
    { 1: ['Screen'] },
    repeat(5, (i) => [
      i * 100,
      20,
      [1],
      [[1, 1, [0, null, [0], null]], ...unnamed.map((id): Render => [id, 1, 'parent'])],
    ]),
  );

  assert.deepEqual(kinds(raw), []);
  assert.deepEqual(
    analyzeReactProfile(raw).components.map((c) => c.name),
    ['Screen'],
  );
});

test('memo-wrapped and plain components of one name are profiled separately', () => {
  const raw = rawProfile({ 1: ['List'], 2: ['Memo(Row)', MEMO, 1], 3: ['Row', FUNCTION, 1] }, [
    [
      0,
      20,
      [1],
      [
        [1, 1, [0, null, [0], null]],
        [2, 4, 'parent'],
        [3, 9, 'parent'],
      ],
    ],
  ]);

  assert.deepEqual(
    analyzeReactProfile(raw).components.map((c) => `${c.name} ${c.kind} ${c.selfMs}`),
    ['Row function 9', 'Row memo 4', 'List function 1'],
  );
});

test('a finding about memo Row does not explain a slow commit spent in plain Row', () => {
  const memoRows = repeat(12, (i) => 10 + i);
  const plainRows = repeat(50, (i) => 100 + i);
  const elements: Record<number, [string, number?, number?]> = { 1: ['List'] };
  for (const id of memoRows) elements[id] = ['Memo(Row)', MEMO, 1];
  for (const id of plainRows) elements[id] = ['Row', FUNCTION, 1];
  const raw = rawProfile(elements, [
    ...repeat(3, (i): [number, number, number[], Render[]] => [
      i * 200,
      10,
      [1],
      [
        [1, 1, [0, null, [0], null]],
        ...memoRows.map((id): Render => [id, 0.5, [0, [0], null, null]]),
      ],
    ]),
    [
      1_000,
      100,
      [1],
      [[1, 0, [0, null, [0], null], 100], ...plainRows.map((id): Render => [id, 2, 1])],
    ],
  ]);

  const findings = analyzeReactProfile(raw).findings;
  const slowCommit = findings.find((finding) => finding.kind === 'slow-commit');
  assert.equal(slowCommit?.costMs, 100);
  assert.match(slowCommit!.evidence, /^commit #3 took 100ms/);
});

test('time inside a subtree a finding accounts for is not counted twice', () => {
  const elements: Record<number, [string, number?, number?, number?]> = {
    1: ['Screen'],
    2: ['Panel', FUNCTION, 1, 1],
    3: ['Box', FUNCTION, 2, 2],
    4: ['View', FUNCTION, 1, 1],
  };
  const raw = rawProfile(elements, [
    ...repeat(12, (i): [number, number, number[], Render[]] => [
      i * 200,
      10,
      [1],
      [
        [1, 1, [0, null, [0], null], 10],
        [2, 1, 'parent', 2],
        [3, 1, 'parent'],
      ],
    ]),
    [
      3_000,
      100,
      [1],
      [
        [1, 2, [0, null, [0], null], 100],
        [4, 55, 'parent'],
        [2, 5, 'parent', 40],
        [3, 35, 'parent'],
      ],
    ],
  ]);

  const findings = analyzeReactProfile(raw).findings;
  assert.ok(
    findings.some((finding) => finding.kind === 'parent-cascade' && finding.component === 'Panel'),
  );
  assert.ok(
    findings.some((finding) => finding.kind === 'parent-cascade' && finding.component === 'Box'),
  );
  assert.match(
    findings.find((finding) => finding.kind === 'slow-commit')?.evidence ?? '',
    /^commit #12 took 100ms/,
    'Panel accounts for 40ms including Box, which leaves most of the commit unexplained',
  );
});

test('a prop whose inspected instances disagree on its kind claims no new identity', () => {
  const rows = repeat(12, (i) => 10 + i);
  const elements: Record<number, [string, number?, number?]> = { 1: ['List'] };
  for (const id of rows) elements[id] = ['Memo(Row)', MEMO, 1];
  const raw = rawProfile(
    elements,
    repeat(3, (i) => [
      i * 200,
      30,
      [1],
      [[1, 1, [0, null, [0], null]], ...rows.map((id): Render => [id, 1, [0, [0], null, null]])],
    ]),
    ['label'],
  );
  const [finding] = analyzeReactProfile(raw, {
    10: { label: 'object' },
    11: { label: 'string' },
  }).findings;

  assert.equal(finding?.kind, 'memo-defeated');
  assert.match(finding!.evidence, /changed label 36x from List \(value kinds not inspected\)$/);
});

test('framework primitives never head a finding even when they re-render the most', () => {
  const texts = repeat(30, (i) => 10 + i);
  const elements: Record<number, [string, number?, number?]> = { 1: ['Screen'] };
  for (const id of texts) elements[id] = ['Text', FUNCTION, 1];
  const raw = rawProfile(
    elements,
    repeat(5, (i) => [
      i * 100,
      20,
      [1],
      [[1, 1, [0, null, [0], null]], ...texts.map((id): Render => [id, 1, 'parent'])],
    ]),
  );

  assert.deepEqual(kinds(raw), []);
  assert.equal(analyzeReactProfile(raw).components.find((c) => c.name === 'Text')?.renders, 150);
});

test('a slow commit nobody explains is reported with its heaviest components', () => {
  const raw = rawProfile({ 1: ['Login'], 2: ['Form', FUNCTION, 1], 3: ['Text', FUNCTION, 2] }, [
    [
      0,
      90,
      [1],
      [
        [1, 12, 1, 90],
        [2, 8, 1, 70],
        [3, 30, 1],
      ],
    ],
  ]);
  const [finding] = analyzeReactProfile(raw).findings;
  assert.equal(finding?.kind, 'slow-commit');
  assert.equal(finding?.component, 'Login');
  assert.equal(
    finding?.evidence,
    'commit #0 took 90ms rendering 3 components (3 mounted) after Login updated; most time in Text 30ms, Login 12ms, Form 8.0ms',
  );
});

test('a slow commit names the app component whose subtree holds the time when it is not the updater', () => {
  const raw = rawProfile(
    { 1: ['Screen'], 2: ['Feed', FUNCTION, 1], 3: ['View', FUNCTION, 2], 4: ['Store'] },
    [
      [
        0,
        100,
        [4],
        [
          [1, 2, [1, null, null, null], 100],
          [2, 3, 'parent', 95],
          [3, 90, 'parent'],
        ],
      ],
    ],
  );
  const [finding] = analyzeReactProfile(raw).findings;
  assert.equal(finding?.component, 'Feed');
  assert.match(
    finding?.evidence ?? '',
    /rendering 3 components inside Feed after Store updated; most time in View 90ms/,
  );
  assert.equal(finding?.fix, 'render less under Feed per update (memoize, virtualize, or defer)');
});

test('cheap patterns stay below the noise floor', () => {
  const rows = repeat(12, (i) => 10 + i);
  const elements: Record<number, [string, number?, number?]> = {
    1: ['List'],
    99: ['Heavy', FUNCTION, 1],
  };
  for (const id of rows) elements[id] = ['Row', FUNCTION, 1];
  const raw = rawProfile(
    elements,
    repeat(2, (i) => [
      i * 300,
      200,
      [1],
      [[1, 1, [0, null, [0], null]], [99, 190], ...rows.map((id): Render => [id, 0.01, 'parent'])],
    ]),
  );
  assert.deepEqual(kinds(raw), ['slow-render Heavy']);
});

test('the summary counts commits over the frame budget and names the worst', () => {
  const raw = rawProfile({ 1: ['A'] }, [
    [0, 10, [1], [[1, 1]]],
    [100, 40, [1], [[1, 1]]],
    [200, 20, [1], [[1, 1]]],
  ]);
  const analysis = analyzeReactProfile(raw);
  assert.equal(analysis.slowCommitCount, 2);
  assert.deepEqual(analysis.worstCommit, { index: 1, durationMs: 40 });
  assert.equal(analysis.renderMs, 70);
  assert.equal(analysis.wallMs, 5_000);
});
