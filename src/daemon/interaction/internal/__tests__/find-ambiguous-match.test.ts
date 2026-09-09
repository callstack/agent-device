import { test, expect, vi, beforeEach } from 'vitest';

vi.mock('@agent-device/device-selection/dispatch-resolve', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveTargetDevice: actual.resolveTargetDevice,
  };
});
vi.mock('../../../snapshot-interactor-capture.ts', async () => {
  const fixture = await import('../../../__tests__/legacy-snapshot-capture-fixture.ts');
  return { captureSnapshotWithInteractor: fixture.captureSnapshotThroughLegacyDispatchFixture };
});

import {
  resetFindTouchRuntimeFixture,
  runFindClickScenario,
} from './find-touch-runtime-fixture.ts';
import { refFrameScope, refFrameState } from '../../../ref-frame.ts';

beforeEach(() => {
  resetFindTouchRuntimeFixture();
});

// #1597: an ambiguous find must let the agent act on the right @ref straight
// from the error, so the response carries snapshot-line-rendered candidates
// (ref, role, label) instead of a bare "matched N elements" message. Capped
// at AMBIGUOUS_MATCH_CANDIDATE_LIMIT (5); the true total keeps riding
// `matches` so a "+N more" marker can be computed at render time.
test('handleFindCommands ambiguous match lists snapshot-line candidates capped at 5', async () => {
  const followButton = (ref: string, index: number, x: number) => ({
    index,
    ref,
    type: 'Button',
    label: 'Follow',
    hittable: true,
    rect: { x, y: 100, width: 80, height: 40 },
    parentIndex: 0,
  });

  const { response } = await runFindClickScenario({
    positionals: ['Follow', 'click'],
    nodes: [
      { index: 0, ref: 'e1', type: 'Application', rect: { x: 0, y: 0, width: 800, height: 1200 } },
      followButton('e2', 1, 0),
      followButton('e3', 2, 90),
      followButton('e4', 3, 180),
      followButton('e5', 4, 270),
      followButton('e6', 5, 360),
      followButton('e7', 6, 450),
    ],
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('AMBIGUOUS_MATCH');
  // The old bare message ("find matched 6 elements ... Use a more specific
  // locator or selector.") gave the agent nothing to act on directly — this
  // proves the fix red against that shape: `candidates` must exist, be
  // snapshot-line rendered, and be capped below the true match count.
  expect(response.error.details?.matches).toBe(6);
  const candidates = response.error.details?.candidates;
  expect(Array.isArray(candidates)).toBe(true);
  expect(candidates).toEqual([
    '@e2 [button] "Follow"',
    '@e3 [button] "Follow"',
    '@e4 [button] "Follow"',
    '@e5 [button] "Follow"',
    '@e6 [button] "Follow"',
  ]);
});

test('handleFindCommands ambiguous match with few candidates lists them all uncapped', async () => {
  const { response } = await runFindClickScenario({
    positionals: ['Follow', 'click'],
    nodes: [
      { index: 0, ref: 'e1', type: 'Application', rect: { x: 0, y: 0, width: 800, height: 1200 } },
      {
        index: 1,
        ref: 'e2',
        type: 'Button',
        label: 'Follow',
        hittable: true,
        rect: { x: 0, y: 100, width: 80, height: 40 },
        parentIndex: 0,
      },
      {
        index: 2,
        ref: 'e3',
        type: 'Button',
        // No label — exact-matches "Follow" via its identifier instead, so
        // this candidate exercises the label/identifier fallback.
        identifier: 'FOLLOW',
        hittable: true,
        rect: { x: 90, y: 100, width: 80, height: 40 },
        parentIndex: 0,
      },
    ],
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('AMBIGUOUS_MATCH');
  expect(response.error.details?.matches).toBe(2);
  // No label on e3, so the candidate line falls back to its identifier —
  // "label/identifier" per #1597, same as any other snapshot line.
  expect(response.error.details?.candidates).toEqual([
    '@e2 [button] "Follow"',
    '@e3 [button] "FOLLOW"',
  ]);
});

// #1625 decision 1: `find <q> list` is the read-only inspection surface the
// recovery hint points at — every match with its ref, unique match included,
// and never a tap (the old hint's "run bare find to list" clicked a unique
// match and navigated).
test('handleFindCommands list returns every match without acting', async () => {
  const follow = (ref: string, index: number, x: number) => ({
    index,
    ref,
    type: 'Button',
    label: 'Follow',
    hittable: true,
    rect: { x, y: 100, width: 80, height: 40 },
    parentIndex: 0,
  });

  const { response, invokeCalls, session } = await runFindClickScenario({
    positionals: ['text', 'Follow', 'list'],
    nodes: [
      { index: 0, ref: 'e1', type: 'Application', rect: { x: 0, y: 0, width: 800, height: 1200 } },
      follow('e2', 1, 0),
      follow('e3', 2, 90),
      follow('e4', 3, 180),
    ],
  });

  expect(response.ok).toBe(true);
  if (!response.ok) return;
  const matches = response.data?.matches as Array<{ ref: string }>;
  expect(matches.map((match) => match.ref)).toEqual(['@e2', '@e3', '@e4']);
  // Inspection only: nothing was clicked, focused, or filled.
  expect(invokeCalls).toHaveLength(0);
  // Ref-issuing: the response carries the generation and the partial frame
  // authorizes EVERY listed body, so any `@eN~sG` from the list can drive the
  // next command (a plain `@eN` still requires a complete frame by design —
  // the MCP/CLI layers pin from `matches` + `refsGeneration`).
  expect(typeof response.data?.refsGeneration).toBe('number');
  expect(refFrameState(session)).toBe('active');
  expect([...refFrameScope(session)].sort()).toEqual(['e2', 'e3', 'e4']);
});

test('handleFindCommands list on a unique match still lists instead of tapping', async () => {
  const { response, invokeCalls } = await runFindClickScenario({
    positionals: ['Dictionary', 'list'],
    nodes: [
      { index: 0, ref: 'e1', type: 'Application', rect: { x: 0, y: 0, width: 800, height: 1200 } },
      {
        index: 1,
        ref: 'e2',
        type: 'Cell',
        label: 'Dictionary',
        hittable: true,
        rect: { x: 0, y: 100, width: 800, height: 44 },
        parentIndex: 0,
      },
    ],
  });

  expect(response.ok).toBe(true);
  if (!response.ok) return;
  const matches = response.data?.matches as Array<{ ref: string }>;
  expect(matches).toHaveLength(1);
  expect(matches[0]?.ref).toBe('@e2');
  expect(invokeCalls).toHaveLength(0);
});

// #1625 decision 2: selector-shaped and text-shaped queries share one
// ambiguity contract. Selectors used to take the first match silently — the
// exact mis-binding path the AMBIGUOUS_MATCH recovery advice pointed at.
test('handleFindCommands selector-shaped find rejects multiple matches with candidates', async () => {
  const button = (ref: string, index: number, label: string, x: number) => ({
    index,
    ref,
    type: 'Button',
    label,
    hittable: true,
    rect: { x, y: 100, width: 80, height: 40 },
    parentIndex: 0,
  });

  const { response, invokeCalls } = await runFindClickScenario({
    positionals: ['role=button', 'click'],
    nodes: [
      { index: 0, ref: 'e1', type: 'Application', rect: { x: 0, y: 0, width: 800, height: 1200 } },
      button('e2', 1, 'Follow', 0),
      button('e3', 2, 'Share', 90),
      button('e4', 3, 'Reply', 180),
    ],
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('AMBIGUOUS_MATCH');
  expect(response.error.details?.matches).toBe(3);
  expect(Array.isArray(response.error.details?.candidates)).toBe(true);
  expect(invokeCalls).toHaveLength(0);
});

test('handleFindCommands selector-shaped find honors the explicit --first opt-out', async () => {
  const button = (ref: string, index: number, label: string, x: number) => ({
    index,
    ref,
    type: 'Button',
    label,
    hittable: true,
    rect: { x, y: 100, width: 80, height: 40 },
    parentIndex: 0,
  });

  const { response, invokeCalls } = await runFindClickScenario({
    positionals: ['role=button', 'click'],
    flags: { findFirst: true },
    nodes: [
      { index: 0, ref: 'e1', type: 'Application', rect: { x: 0, y: 0, width: 800, height: 1200 } },
      button('e2', 1, 'Follow', 0),
      button('e3', 2, 'Share', 90),
    ],
  });

  expect(response.ok).toBe(true);
  expect(invokeCalls[0]?.positionals?.[0]).toBe('@e2');
});
