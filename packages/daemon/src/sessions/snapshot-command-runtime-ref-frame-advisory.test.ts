import path from 'node:path';
import crypto from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { makeIosSession } from '../__tests__/support/session-factories.ts';
import { activateCompleteRefFrame, expireRefFrame } from '../core/ref-frame.ts';
import { dispatchSnapshotDiffViaRuntime } from './snapshot-diff-runtime.ts';
import { dispatchSnapshotViaRuntime } from './snapshot-runtime.ts';
import { SessionStore } from '../core/session-store.ts';
import { legacyDispatchCapture } from '../__tests__/support/legacy-snapshot-capture-fixture.ts';
import { snapshotRuntimeFixture } from '../__tests__/support/snapshot-runtime-fixture.ts';
import { createLiveTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { forwardingCreateCommandSurfaceWithAnnotations as testCreateCommandSurface } from '../__tests__/support/command-surface-fake.ts';

vi.mock('../core/snapshot-interactor-capture.ts', async () => {
  const fixture = await import('../__tests__/support/legacy-snapshot-capture-fixture.ts');
  return { captureSnapshotWithInteractor: fixture.captureSnapshotThroughLegacyDispatchFixture };
});

function scenario() {
  const root = path.join(
    mkdtempForTestSync('agent-device-ref-frame-advisory'),
    `agent-device-ref-frame-advisory-${crypto.randomUUID()}`,
  );
  const sessionStore = new SessionStore(
    path.join(root, 'sessions'),
    createLiveTestHostEnvironment(),
  );
  const sessionName = 'default';
  sessionStore.publish(
    sessionName,
    makeIosSession(sessionName, { appBundleId: 'com.example.app' }),
  );
  return { sessionStore, sessionName, logPath: path.join(root, 'daemon.log') };
}

function seedCapture() {
  legacyDispatchCapture.mockResolvedValue({
    backend: 'xctest',
    truncated: false,
    quality: { state: 'healthy', backend: 'tree' },
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        label: 'Continue',
        rect: { x: 0, y: 0, width: 100, height: 44 },
        hittable: true,
      },
    ],
  });
}

async function dispatchPublicSnapshot(input: ReturnType<typeof scenario>) {
  return await dispatchSnapshotViaRuntime({
    createCommandSurface: testCreateCommandSurface,
    req: { command: 'snapshot', positionals: [], token: 't', session: input.sessionName },
    sessionName: input.sessionName,
    logPath: input.logPath,
    sessionStore: input.sessionStore,
    ...snapshotRuntimeFixture(),
  });
}

async function dispatchInternalSnapshot(input: ReturnType<typeof scenario>) {
  return await dispatchSnapshotViaRuntime({
    createCommandSurface: testCreateCommandSurface,
    req: {
      command: 'snapshot',
      positionals: [],
      token: 't',
      session: input.sessionName,
      internal: { observationOnly: true },
    },
    sessionName: input.sessionName,
    logPath: input.logPath,
    sessionStore: input.sessionStore,
    ...snapshotRuntimeFixture(),
  });
}

async function dispatchRefScopedDiff(input: ReturnType<typeof scenario>) {
  return await dispatchSnapshotDiffViaRuntime({
    createCommandSurface: testCreateCommandSurface,
    req: {
      command: 'diff',
      positionals: [],
      token: 't',
      session: input.sessionName,
      flags: { snapshotScope: '@e1' },
    },
    sessionName: input.sessionName,
    logPath: input.logPath,
    sessionStore: input.sessionStore,
    ...snapshotRuntimeFixture(),
  });
}

function responseWarnings(response: {
  ok: boolean;
  data?: Record<string, unknown> | undefined;
}): string[] {
  if (!response.ok) throw new Error('expected ok response');
  const warnings = response.data?.warnings;
  return Array.isArray(warnings) ? (warnings as string[]) : [];
}

function hintLines(response: Parameters<typeof responseWarnings>[0]): string[] {
  return responseWarnings(response).filter((line) => line.startsWith('Hint: '));
}

/** One device action between two public snapshots, through the real side-effect seam. */
function actBetweenSnapshots(input: ReturnType<typeof scenario>): void {
  const session = input.sessionStore.get(input.sessionName);
  if (!session) throw new Error('expected a stored session');
  expireRefFrame(session);
}

test('the snapshot-per-action hint rides the closing fourth public snapshot response once', async () => {
  const input = scenario();
  seedCapture();

  await dispatchPublicSnapshot(input);
  actBetweenSnapshots(input);
  await dispatchPublicSnapshot(input);
  actBetweenSnapshots(input);
  await dispatchPublicSnapshot(input);
  actBetweenSnapshots(input);

  const armed = await dispatchPublicSnapshot(input);
  expect(hintLines(armed)).toHaveLength(1);
  expect(hintLines(armed)[0]).toContain('the last 3 snapshots in a row');

  const next = await dispatchPublicSnapshot(input);
  expect(hintLines(next)).toHaveLength(0);
});

test('an internal-observation snapshot response never carries the hint', async () => {
  const input = scenario();
  seedCapture();

  await dispatchPublicSnapshot(input);
  actBetweenSnapshots(input);
  await dispatchPublicSnapshot(input);
  actBetweenSnapshots(input);
  await dispatchPublicSnapshot(input);
  actBetweenSnapshots(input);

  const internal = await dispatchInternalSnapshot(input);
  expect(hintLines(internal)).toHaveLength(0);

  // The next public snapshot is a fourth consecutive closed round, so the
  // advisory arms again on its own activation instead of the leaked one-shot.
  const armed = await dispatchPublicSnapshot(input);
  expect(hintLines(armed)).toHaveLength(1);
});

test('a diff response never carries the hint', async () => {
  const input = scenario();
  seedCapture();

  // Two closed rounds through the real dispatch seam, so the stored snapshot and
  // its frame carry the evidence the scoped diff later admits against.
  await dispatchPublicSnapshot(input);
  actBetweenSnapshots(input);
  await dispatchPublicSnapshot(input);
  actBetweenSnapshots(input);
  await dispatchPublicSnapshot(input);
  actBetweenSnapshots(input);

  // The third closed round is driven on the stored session directly; a real
  // dispatch would only add the same transition pair.
  const stored = input.sessionStore.get(input.sessionName);
  if (!stored) throw new Error('expected a stored session');
  activateCompleteRefFrame(stored);

  // The runner owns scope publication and returns an empty projection for a miss,
  // which deliberately retains the stored snapshot and issues no complete frame.
  legacyDispatchCapture.mockResolvedValue({
    backend: 'xctest',
    truncated: false,
    quality: { state: 'healthy', backend: 'tree' },
    nodes: [],
  });
  const diff = await dispatchRefScopedDiff(input);
  expect(hintLines(diff)).toHaveLength(0);

  // The diff consumed the armed one-shot, and the round count survives it: the
  // next snapshot that closes a fourth round arms again on its own activation.
  seedCapture();
  actBetweenSnapshots(input);
  const next = await dispatchPublicSnapshot(input);
  expect(hintLines(next)).toHaveLength(1);
});
