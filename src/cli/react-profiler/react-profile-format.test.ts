import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { Finding, ReactProfileAnalysis } from './react-profile-analysis.ts';
import type { ComponentProfile } from './react-profile-renders.ts';
import {
  findComponents,
  formatCommit,
  formatComponentReport,
  formatProfileSummary,
  formatRerenders,
  formatSlowComponents,
  formatTimeline,
} from './react-profile-format.ts';

function component(name: string, overrides: Partial<ComponentProfile> = {}): ComponentProfile {
  return {
    name,
    kind: 'function',
    instances: 1,
    renders: 4,
    selfMs: 40,
    maxSelfMs: 12,
    causes: { mount: 1, props: 3, state: 0, hooks: 0, context: 0, parent: 0 },
    changedProps: { onPress: 3 },
    changedState: {},
    changedHooks: {},
    owners: {},
    propKinds: {},
    costliestCommits: [],
    ...overrides,
  };
}

function finding(index: number): Finding {
  return {
    kind: 'slow-render',
    component: `C${index}`,
    costMs: 100 - index,
    evidence: 'slow',
    fix: 'memoize',
  };
}

function analysis(overrides: Partial<ReactProfileAnalysis> = {}): ReactProfileAnalysis {
  return {
    version: 1,
    wallMs: 3_200,
    commitCount: 4,
    renderMs: 96,
    slowCommitCount: 2,
    worstCommit: { index: 2, durationMs: 41.5 },
    naming: 'operations',
    notes: [],
    components: [component('Chart'), component('Row', { renders: 9, instances: 3, selfMs: 9 })],
    commits: [
      {
        index: 0,
        atMs: 0,
        durationMs: 10,
        rendered: 3,
        mounts: 0,
        updaters: ['List'],
        top: [],
      },
      {
        index: 1,
        atMs: 900,
        durationMs: 41.5,
        rendered: 30,
        mounts: 30,
        updaters: [],
        top: [],
      },
    ],
    findings: [finding(1)],
    ...overrides,
  };
}

test('the summary is a headline, one line per finding, and the drill-down commands', () => {
  assert.equal(
    formatProfileSummary(analysis()),
    [
      'React profile 3.2s: 4 commits, 96ms rendering, 2 over 16ms (worst #2 42ms)',
      '1. slow-render C1: slow -> memoize',
      'More: profile slow | profile rerenders | profile report <Component> | profile timeline | profile commit <N>',
    ].join('\n'),
  );
});

test('the summary caps findings and says how to see the rest', () => {
  const text = formatProfileSummary(analysis({ findings: [1, 2, 3, 4].map(finding) }), 2);
  assert.match(text, /\n2\. slow-render C2: slow -> memoize\n\+2 smaller findings \(--limit 4\)\n/);
});

test('the summary reports clean profiles and empty recordings in one line', () => {
  assert.match(
    formatProfileSummary(analysis({ findings: [], slowCommitCount: 0 })),
    /^React profile 3\.2s: 4 commits, 96ms rendering\nNo render problems above thresholds\./,
  );
  assert.match(
    formatProfileSummary(analysis({ commitCount: 0 })),
    /^React profile: no commits recorded\./,
  );
});

test('lookup naming warns that unmounted components may be unnamed', () => {
  assert.match(
    formatProfileSummary(analysis({ naming: 'lookup' })),
    /\nNote: component names came from mounted elements/,
  );
});

test('slow and rerender tables rank by self time and render count', () => {
  assert.match(
    formatSlowComponents(analysis(), 1),
    /^Components by self time:\n {2}Chart \[function\] self 40ms avg 10ms max 12ms renders 4\n {2}\+1 more \(--limit 2\)$/,
  );
  assert.match(
    formatRerenders(analysis(), 1),
    /^Components by render count:\n {2}Row \[function\] 9 renders 3 inst: props 3, mount 1; changed props onPress 3\n {2}\+1 more \(--limit 2\)$/,
  );
});

test('the timeline lists commits with their trigger and mounts', () => {
  assert.equal(
    formatTimeline(analysis(), 5, false),
    'Commits:\n  #0 +0.0s 10ms 3 rendered <- List\n  #1 +0.9s 42ms 30 rendered (30 mounted)',
  );
  assert.match(formatTimeline(analysis(), 1, true), /^Slowest commits \(1 of 2\):\n {2}#1/);
});

test('component lookup falls back to a case-insensitive match', () => {
  assert.deepEqual(
    findComponents(analysis(), 'chart').map((c) => c.name),
    ['Chart'],
  );
  assert.deepEqual(findComponents(analysis(), 'Missing'), []);
});

test('a report covers every component of the name, then its findings once', () => {
  const base = analysis();
  const row = base.components.find((c) => c.name === 'Row')!;
  const memoRow = { ...row, kind: 'memo' as const, renders: 2, selfMs: 4, maxSelfMs: 2 };
  const withVariants = {
    ...base,
    components: [...base.components, memoRow],
    findings: [
      {
        kind: 'parent-cascade' as const,
        component: 'Row',
        costMs: 9,
        evidence: 'often re-renders',
        fix: 'memoize',
      },
    ],
  };
  const variants = findComponents(withVariants, 'Row');
  assert.deepEqual(
    variants.map((c) => c.kind),
    ['function', 'memo'],
  );
  const text = formatComponentReport(withVariants, variants);
  assert.match(text, /^Row \[function\][^\n]*\n[\s\S]*\nRow \[memo\] self 4\.0ms/);
  assert.equal(text.match(/finding parent-cascade/g)?.length, 1);
});

test('a commit entry without recorded changes says its cause is unrecorded', () => {
  const text = formatCommit(
    {
      index: 3,
      atMs: 1200,
      durationMs: 20,
      rendered: 2,
      mounts: 0,
      updaters: [],
      top: [{ name: 'Row', instances: 2, selfMs: 12, actualMs: 18, causes: [] }],
    },
    5,
  );
  assert.equal(text, '#3 +1.2s 20ms 2 rendered\n  Row x2 self 12ms unrecorded');
});
