import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceBackend } from '../../../backend.ts';
import { ref, selector } from './selector-read.ts';
import { createLocalArtifactAdapter } from '../../../io.ts';
import {
  createAgentDevice,
  createMemorySessionStore,
  localCommandPolicy,
} from '../../../runtime.ts';
import type { Point } from '../../../kernel/snapshot.ts';
import { makeSnapshotState } from '../../../__tests__/test-utils/index.ts';
import {
  coveredByTabBarSnapshot,
  createInteractionDevice,
  fillableSnapshot,
  nonHittableCellSnapshot,
  offscreenDrawerSnapshot,
  selectorSnapshot,
} from './__tests__/test-utils/index.ts';

test('runtime click taps an explicit point without requiring a snapshot', async () => {
  const calls: Array<{ point: Point; count?: number }> = [];
  const device = createInteractionDevice(selectorSnapshot(), {
    tap: async (_context, point, options) => {
      calls.push({ point, count: options?.count });
    },
  });

  const result = await device.interactions.click({ kind: 'point', x: 10, y: 20 }, { count: 2 });

  assert.deepEqual(calls, [{ point: { x: 10, y: 20 }, count: 2 }]);
  assert.deepEqual(result, { kind: 'point', point: { x: 10, y: 20 } });
});

test('runtime click with verify captures a baseline for point targets and reports evidence', async () => {
  let captureCount = 0;
  const device = createInteractionDevice(selectorSnapshot(), {
    captureSnapshot: async () => {
      captureCount += 1;
      if (captureCount === 1) return { snapshot: selectorSnapshot() };
      return { snapshot: makeSnapshotState([]) };
    },
    tap: async () => ({ ok: true }),
  });

  const result = await device.interactions.click(
    { kind: 'point', x: 10, y: 20 },
    { session: 'default', verify: true },
  );

  assert.equal(result.kind, 'point');
  assert.ok(result.evidence);
  assert.equal(result.evidence?.changedFromBefore, true);
  assert.equal(result.evidence?.nodeCount, 0);
  assert.equal(captureCount, 2);
});

test('runtime click with verify skips the native ref fast path so evidence can be captured', async () => {
  const calls: string[] = [];
  let captureCount = 0;
  const device = createInteractionDevice(selectorSnapshot(), {
    platform: 'web',
    captureSnapshot: async () => {
      captureCount += 1;
      return { snapshot: selectorSnapshot() };
    },
    tapTarget: async (_context, target) => {
      calls.push(target.ref);
      return { ref: target.ref.replace(/^@/, '') };
    },
    tap: async () => ({ ok: true }),
  });

  const result = await device.interactions.click(ref('@e1'), {
    session: 'default',
    verify: true,
  });

  assert.deepEqual(calls, []);
  assert.equal(result.kind, 'ref');
  assert.ok(result.evidence);
  assert.ok(captureCount >= 1);
});

test('runtime click uses backend ref primitive without resolving snapshot geometry', async () => {
  const calls: string[] = [];
  const device = createInteractionDevice(selectorSnapshot(), {
    platform: 'web',
    captureSnapshot: async () => {
      throw new Error('native ref click should not capture a snapshot');
    },
    tapTarget: async (_context, target) => {
      calls.push(target.ref);
      return { ref: target.ref.replace(/^@/, '') };
    },
  });

  const result = await device.interactions.click(ref('@e2'), { session: 'default' });

  assert.deepEqual(calls, ['@e2']);
  assert.equal(result.kind, 'ref');
  assert.deepEqual(result.target, { kind: 'ref', ref: '@e2' });
  assert.equal(result.point, undefined);
  assert.equal(result.node, undefined);
  assert.deepEqual(result.backendResult, { ref: 'e2' });
});

test('runtime fill uses backend ref primitive without resolving snapshot geometry', async () => {
  const calls: Array<{ ref: string; text: string; delayMs?: number }> = [];
  const device = createInteractionDevice(fillableSnapshot(), {
    platform: 'web',
    captureSnapshot: async () => {
      throw new Error('native ref fill should not capture a snapshot');
    },
    fillTarget: async (_context, target, text, options) => {
      calls.push({ ref: target.ref, text, delayMs: options?.delayMs });
      return { ref: target.ref.replace(/^@/, ''), text };
    },
  });

  const result = await device.interactions.fill(ref('@e1'), 'hello', {
    session: 'default',
    delayMs: 25,
  });

  assert.deepEqual(calls, [{ ref: '@e1', text: 'hello', delayMs: 25 }]);
  assert.equal(result.kind, 'ref');
  assert.equal(result.point, undefined);
  // ADR 0012 decision 3: the preflight's guard lookup supplies the
  // record-time evidence node on the runtime result.
  assert.equal(result.node?.ref, 'e1');
  assert.ok(Array.isArray(result.preActionNodes));
  assert.deepEqual(result.target, { kind: 'ref', ref: '@e1' });
  assert.equal(result.text, 'hello');
  assert.deepEqual(result.backendResult, { ref: 'e1', text: 'hello' });
});

test('native ref click preflight refuses an off-screen ref without calling the backend', async () => {
  // Closed-drawer shape (ADR 0011): the stored session snapshot already holds
  // the node, so the fast path must refuse it with the runtime path's exact
  // offscreen_ref shape instead of letting the backend silently "succeed".
  const calls: string[] = [];
  const device = createInteractionDevice(offscreenDrawerSnapshot(), {
    platform: 'web',
    captureSnapshot: async () => {
      throw new Error('native ref preflight must not capture a snapshot');
    },
    tapTarget: async (_context, target) => {
      calls.push(target.ref);
      return {};
    },
  });

  await assert.rejects(
    () => device.interactions.click(ref('@e2'), { session: 'default' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Ref @e2 is off-screen and not safe to click/);
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, 'offscreen_ref');
      assert.equal(details?.ref, 'e2');
      assert.ok(typeof details?.hint === 'string');
      return true;
    },
  );
  assert.deepEqual(calls, []);
});

test('native ref fill preflight refuses an off-screen ref without calling the backend', async () => {
  const calls: string[] = [];
  const device = createInteractionDevice(offscreenDrawerSnapshot(), {
    platform: 'web',
    captureSnapshot: async () => {
      throw new Error('native ref preflight must not capture a snapshot');
    },
    fillTarget: async (_context, target) => {
      calls.push(target.ref);
      return {};
    },
  });

  await assert.rejects(
    () => device.interactions.fill(ref('@e2'), 'hello', { session: 'default' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Ref @e2 is off-screen and not safe to fill/);
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, 'offscreen_ref');
      return true;
    },
  );
  assert.deepEqual(calls, []);
});

test('native ref click preflight refuses a covered ref without calling the backend', async () => {
  const calls: string[] = [];
  const device = createInteractionDevice(coveredByTabBarSnapshot(), {
    platform: 'web',
    captureSnapshot: async () => {
      throw new Error('native ref preflight must not capture a snapshot');
    },
    tapTarget: async (_context, target) => {
      calls.push(target.ref);
      return {};
    },
  });

  await assert.rejects(
    () => device.interactions.click(ref('@e2'), { session: 'default' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      // Same shape as the runtime path's buildCoveredInteractionError.
      assert.match(error.message, /Ref @e2 is covered by another visible element/);
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.ref, '@e2');
      assert.equal(details?.interactionBlocked, 'covered');
      return true;
    },
  );
  assert.deepEqual(calls, []);
});

test('native ref click preflight annotates non-hittable targets but still calls the backend', async () => {
  const calls: string[] = [];
  const device = createInteractionDevice(nonHittableCellSnapshot(), {
    platform: 'web',
    captureSnapshot: async () => {
      throw new Error('native ref preflight must not capture a snapshot');
    },
    tapTarget: async (_context, target) => {
      calls.push(target.ref);
      return { ref: target.ref.replace(/^@/, '') };
    },
  });

  const result = await device.interactions.click(ref('@e2'), { session: 'default' });

  // Annotation only: the backend still acts on the ref (no promotion on the
  // fast path), and the result carries the same targetHittable/hint fields
  // the runtime path attaches.
  assert.deepEqual(calls, ['@e2']);
  assert.equal(result.kind, 'ref');
  assert.equal(result.targetHittable, false);
  assert.match(result.hint ?? '', /hittable: false/);
  assert.deepEqual(result.backendResult, { ref: 'e2' });
});

test('native ref fast path proceeds untouched when the session has no snapshot', async () => {
  const calls: string[] = [];
  const device = createAgentDevice({
    backend: {
      platform: 'web',
      captureSnapshot: async () => {
        throw new Error('native ref preflight must not capture a snapshot');
      },
      tap: async () => {},
      typeText: async () => {},
      tapTarget: async (_context, target) => {
        calls.push(target.ref);
        return { ref: target.ref.replace(/^@/, '') };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default' }]),
    policy: localCommandPolicy(),
  });

  const result = await device.interactions.click(ref('@e2'), { session: 'default' });

  assert.deepEqual(calls, ['@e2']);
  assert.equal(result.kind, 'ref');
  assert.equal(result.targetHittable, undefined);
  assert.equal(result.hint, undefined);
  assert.deepEqual(result.backendResult, { ref: 'e2' });
});

test('runtime interactions pass runtime signal to backend primitives', async () => {
  const controller = new AbortController();
  let signal: AbortSignal | undefined;
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      tap: async (context) => {
        signal = context.signal;
      },
      typeText: async () => {},
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    policy: localCommandPolicy(),
    signal: controller.signal,
  });

  await device.interactions.click({ kind: 'point', x: 1, y: 2 });

  assert.equal(signal, controller.signal);
});

test('runtime press with verify drops the non-hittable hint when evidence proves a change', async () => {
  let captureCount = 0;
  const nonHittableSnapshot = () =>
    makeSnapshotState([
      {
        index: 0,
        depth: 0,
        type: 'Button',
        label: 'Continue',
        rect: { x: 10, y: 20, width: 100, height: 40 },
        hittable: false,
      },
    ]);
  const changedSnapshot = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Button',
      label: 'Next screen',
      rect: { x: 10, y: 20, width: 100, height: 40 },
      hittable: true,
    },
  ]);
  const device = createInteractionDevice(nonHittableSnapshot(), {
    captureSnapshot: async () => {
      captureCount += 1;
      return { snapshot: captureCount === 1 ? nonHittableSnapshot() : changedSnapshot };
    },
    tap: async () => ({ ok: true }),
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
    verify: true,
  });

  assert.equal(result.kind, 'selector');
  if (result.kind !== 'selector') return;
  assert.equal(result.targetHittable, false);
  assert.equal(result.evidence?.changedFromBefore, true);
  // The "may have had no visible effect" warning is contradicted by the
  // evidence sitting next to it — it must be dropped.
  assert.equal('hint' in result, false);
});

test('runtime press with settle drops the non-hittable hint when the diff proves a change', async () => {
  const nonHittableSnapshot = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Button',
      label: 'Continue',
      rect: { x: 10, y: 20, width: 100, height: 40 },
      hittable: false,
    },
  ]);
  const changedSnapshot = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'StaticText',
      label: 'Welcome',
      rect: { x: 10, y: 20, width: 100, height: 40 },
      hittable: true,
    },
  ]);
  let captureCount = 0;
  const device = createInteractionDevice(nonHittableSnapshot, {
    captureSnapshot: async () => {
      captureCount += 1;
      return { snapshot: captureCount === 1 ? nonHittableSnapshot : changedSnapshot };
    },
    tap: async () => ({ ok: true }),
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
    settle: { quietMs: 25, timeoutMs: 2_000 },
  });

  assert.equal(result.kind, 'selector');
  if (result.kind !== 'selector') return;
  assert.equal(result.targetHittable, false);
  assert.deepEqual(result.settle?.diff?.summary, { additions: 1, removals: 1, unchanged: 0 });
  assert.equal('hint' in result, false);
});

test('runtime press keeps the non-hittable hint when evidence shows no change', async () => {
  const nonHittableSnapshot = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Button',
      label: 'Continue',
      rect: { x: 10, y: 20, width: 100, height: 40 },
      hittable: false,
    },
  ]);
  const device = createInteractionDevice(nonHittableSnapshot, {
    tap: async () => ({ ok: true }),
  });

  const verified = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
    verify: true,
  });
  assert.equal(verified.evidence?.changedFromBefore, false);
  assert.match(
    ('hint' in verified ? verified.hint : undefined) ?? '',
    /may have had no visible effect/,
  );

  const unverified = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
  });
  assert.match(
    ('hint' in unverified ? unverified.hint : undefined) ?? '',
    /may have had no visible effect/,
  );
});

test('runtime press without verify omits evidence entirely', async () => {
  const device = createInteractionDevice(selectorSnapshot(), {
    tap: async () => ({ ok: true }),
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
  });

  assert.equal('evidence' in result, false);
});

test('runtime press with verify reports unchanged evidence when the post-action capture matches', async () => {
  const device = createInteractionDevice(selectorSnapshot(), {
    tap: async () => ({ ok: true }),
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
    verify: true,
  });

  assert.equal(result.kind, 'selector');
  assert.ok(result.evidence);
  assert.equal(result.evidence?.changedFromBefore, false);
  assert.equal(result.evidence?.nodeCount, 1);
  assert.equal(result.evidence?.interactiveNodeCount, 1);
  assert.equal(typeof result.evidence?.digest, 'string');
  assert.ok(result.evidence?.digest.startsWith('ax1:'));
});

test('runtime press with verify reports changedFromBefore true when the post-action capture differs', async () => {
  let captureCount = 0;
  const device = createInteractionDevice(selectorSnapshot(), {
    captureSnapshot: async () => {
      captureCount += 1;
      if (captureCount === 1) return { snapshot: selectorSnapshot() };
      return {
        snapshot: makeSnapshotState([
          {
            index: 0,
            depth: 0,
            type: 'Button',
            label: 'Continue',
            value: 'Continue',
            rect: { x: 10, y: 20, width: 100, height: 40 },
            hittable: true,
          },
          {
            index: 1,
            depth: 0,
            type: 'Text',
            label: 'Loading…',
            rect: { x: 10, y: 80, width: 100, height: 20 },
            hittable: true,
          },
        ]),
      };
    },
    tap: async () => ({ ok: true }),
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
    verify: true,
  });

  assert.equal(result.kind, 'selector');
  assert.ok(result.evidence);
  assert.equal(result.evidence?.changedFromBefore, true);
  assert.equal(result.evidence?.nodeCount, 2);
});

test('runtime fill without verify omits evidence entirely', async () => {
  const device = createInteractionDevice(fillableSnapshot(), {
    fill: async () => ({ ok: true }),
  });

  const result = await device.interactions.fill(selector('label=Email'), 'hi', {
    session: 'default',
  });

  assert.equal('evidence' in result, false);
});

test('runtime fill with verify reports evidence and detects a changed post-action capture', async () => {
  let captureCount = 0;
  const device = createInteractionDevice(fillableSnapshot(), {
    captureSnapshot: async () => {
      captureCount += 1;
      if (captureCount === 1) return { snapshot: fillableSnapshot() };
      return {
        snapshot: makeSnapshotState([
          {
            index: 0,
            depth: 0,
            type: 'XCUIElementTypeTextField',
            label: 'Email',
            value: 'hi',
            rect: { x: 20, y: 10, width: 60, height: 40 },
            hittable: true,
          },
        ]),
      };
    },
    fill: async () => ({ ok: true }),
  });

  const result = await device.interactions.fill(selector('label=Email'), 'hi', {
    session: 'default',
    verify: true,
  });

  assert.equal(result.kind, 'selector');
  assert.ok(result.evidence);
  // Digest is over (type, label, identifier) only, so a value-only change does
  // not flip the digest — this is intentional (see ax-digest.ts docs).
  assert.equal(result.evidence?.changedFromBefore, false);
  assert.equal(result.evidence?.nodeCount, 1);
});

test('runtime fill resolves refs and forwards text to the backend primitive', async () => {
  const calls: Array<{ point: Point; text: string; delayMs?: number }> = [];
  const device = createInteractionDevice(fillableSnapshot(), {
    captureSnapshot: async () => {
      throw new Error('ref fill should use the stored session snapshot');
    },
    fill: async (_context, point, text, options) => {
      calls.push({ point, text, delayMs: options?.delayMs });
    },
  });

  const result = await device.interactions.fill(ref('@e1'), 'hello', {
    session: 'default',
    delayMs: 25,
  });

  assert.deepEqual(calls, [{ point: { x: 50, y: 30 }, text: 'hello', delayMs: 25 }]);
  assert.equal(result.kind, 'ref');
  assert.deepEqual(result.target, { kind: 'ref', ref: '@e1' });
  assert.equal(result.text, 'hello');
  assert.equal(result.warning, undefined);
});

test('runtime typeText validates refs and forwards text to the backend primitive', async () => {
  const calls: Array<{ text: string; delayMs?: number }> = [];
  const device = createInteractionDevice(selectorSnapshot(), {
    typeText: async (_context, text, options) => {
      calls.push({ text, delayMs: options?.delayMs });
    },
  });

  const result = await device.interactions.typeText('hello', {
    session: 'default',
    delayMs: 25,
  });

  assert.deepEqual(calls, [{ text: 'hello', delayMs: 25 }]);
  assert.equal(result.kind, 'text');
  assert.equal(result.text, 'hello');
  assert.equal(result.delayMs, 25);
  assert.equal(result.message, 'Typed 5 chars');

  await assert.rejects(
    () => device.interactions.typeText('@e1 hello', { session: 'default' }),
    /type does not accept a target ref/,
  );
});

test('coordinate tap with out-of-bounds point warns when session has viewport', async () => {
  const device = createInteractionDevice(
    makeSnapshotState([
      {
        index: 0,
        depth: 0,
        type: 'Application',
        rect: { x: 0, y: 0, width: 400, height: 800 },
        hittable: true,
      },
    ]),
    {
      tap: async () => ({ ok: true }),
    },
  );

  const result = await device.interactions.click(
    { kind: 'point', x: 500, y: 500 },
    {
      session: 'default',
    },
  );

  assert.equal(result.kind, 'point');
  assert.equal(
    result.warning,
    'Coordinates (500, 500) are outside the last-known viewport (400x800). The tap will be forwarded anyway; take a fresh snapshot if the screen changed.',
  );
});

test('coordinate tap with in-bounds point has no warning', async () => {
  const device = createInteractionDevice(
    makeSnapshotState([
      {
        index: 0,
        depth: 0,
        type: 'Application',
        rect: { x: 0, y: 0, width: 400, height: 800 },
        hittable: true,
      },
    ]),
    {
      tap: async () => ({ ok: true }),
    },
  );

  const result = await device.interactions.click(
    { kind: 'point', x: 200, y: 400 },
    {
      session: 'default',
    },
  );

  assert.equal(result.kind, 'point');
  assert.equal('warning' in result, false);
});

test('coordinate tap with no session snapshot has no warning', async () => {
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      tap: async () => ({ ok: true }),
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default' }]),
    policy: localCommandPolicy(),
  });

  const result = await device.interactions.click(
    { kind: 'point', x: 500, y: 500 },
    {
      session: 'default',
    },
  );

  assert.equal(result.kind, 'point');
  assert.equal('warning' in result, false);
});
