import { expect, test } from 'vitest';
import {
  armRepair,
  isRecordingPublication,
  resolveScriptTarget,
} from '../session-script-publication-state.ts';

// The retention table for the per-target force model (#1258). The repair suites pin these
// transitively through healed-sibling paths; this pins the transition itself, so a regression
// names the rule it broke instead of a downstream path assertion.

test('a bare re-arm keeps a materialized explicit target and its grant', () => {
  const previous = { kind: 'explicit', path: '/flows/a.healed.ad', force: true } as const;
  expect(resolveScriptTarget(previous, { force: false })).toEqual(previous);
});

test('a bare re-arm with live force adds the grant without touching the path', () => {
  expect(
    resolveScriptTarget(
      { kind: 'explicit', path: '/flows/a.healed.ad', force: false },
      { force: true },
    ),
  ).toEqual({ kind: 'explicit', path: '/flows/a.healed.ad', force: true });
});

test('re-arming the same explicit path keeps an existing grant', () => {
  expect(
    resolveScriptTarget(
      { kind: 'explicit', path: '/flows/a.ad', force: true },
      { path: '/flows/a.ad', force: false },
    ),
  ).toEqual({ kind: 'explicit', path: '/flows/a.ad', force: true });
});

test('retargeting to a different explicit path without live force drops the grant', () => {
  expect(
    resolveScriptTarget(
      { kind: 'explicit', path: '/flows/a.ad', force: true },
      { path: '/flows/b.ad', force: false },
    ),
  ).toEqual({ kind: 'explicit', path: '/flows/b.ad', force: false });
});

test('moving from default to an explicit path keeps the grant (#1258 flagged retention)', () => {
  expect(
    resolveScriptTarget({ kind: 'default', force: true }, { path: '/flows/out.ad', force: false }),
  ).toEqual({ kind: 'explicit', path: '/flows/out.ad', force: true });
});

test('per-step repair re-arms never move the boundary or wipe the healed sibling', () => {
  const armed = armRepair(
    { kind: 'none' },
    {
      requested: { path: '/flows/login.healed.ad', force: false },
      boundary: 3,
      sourcePath: '/flows/login.ad',
    },
  );
  const rearmed = armRepair(armed, { requested: { force: false }, boundary: 0 });
  expect(rearmed).toEqual(armed);
});

// --- Recording is derived from the lifecycle, not stored beside it ---
//
// `SessionState.recordSession` used to hold this answer as a second source of truth, which is how
// #1533 happened: a `--save-script` ingress re-armed the flag behind an ABORTED status. These pin
// the whole table, because the predicate now decides both evidence capture and publication.

const target = { kind: 'default', force: false } as const;

test('a session with no publication lifecycle records nothing', () => {
  expect(isRecordingPublication({ kind: 'none' })).toBe(false);
});

test('ordinary authoring records only while ARMED', () => {
  expect(isRecordingPublication({ kind: 'authoring', status: 'armed', target })).toBe(true);
  expect(isRecordingPublication({ kind: 'authoring', status: 'aborted', target })).toBe(false);
  expect(isRecordingPublication({ kind: 'authoring', status: 'published', target })).toBe(false);
});

test('a repair transaction records for its whole lifetime, terminal statuses included', () => {
  // Deliberately exact, not merely safe: `armRepairStep` armed the old flag and neither
  // `abortRepair` nor `commitRepair` ever cleared it, so narrowing this would silently stop
  // evidence capture for a committed or aborted repair.
  for (const status of ['armed', 'complete', 'close-succeeded', 'committed', 'aborted'] as const) {
    expect(isRecordingPublication({ kind: 'repair', status, target, boundary: 0 })).toBe(true);
  }
});
