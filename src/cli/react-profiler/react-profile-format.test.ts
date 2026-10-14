import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { Finding, ReactProfileAnalysis } from './react-profile-analysis.ts';
import type { ComponentProfile } from './react-profile-renders.ts';
import { formatProfileSummary } from './react-profile-format.ts';

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

test('the summary is a headline and one line per finding', () => {
  assert.equal(
    formatProfileSummary(analysis()),
    [
      'React profile 3.2s: 4 commits, 96ms rendering, 2 over 16ms (worst #2 42ms)',
      '1. slow-render C1: slow -> memoize',
    ].join('\n'),
  );
});

test('the summary caps findings and says how to see the rest', () => {
  const text = formatProfileSummary(analysis({ findings: [1, 2, 3, 4].map(finding) }), 2);
  assert.match(text, /\n2\. slow-render C2: slow -> memoize\n\+2 smaller findings \(--limit 4\)$/);
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
