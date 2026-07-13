/**
 * ADR 0012 decision 6, R7 (C5a): when a repair session was reaped before it was
 * finalized, the request router rewrites the resulting `SESSION_NOT_FOUND` into
 * a `REPAIR_SESSION_EXPIRED` recovery error with actionable re-run guidance,
 * rather than leaking a bare SESSION_NOT_FOUND. Any other error, or the absence
 * of a live tombstone, passes through unchanged.
 */
import { test, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getResolveTargetDeviceMock } from './request-router-dispatch-mocks.ts';

vi.mock('../device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));

import { createRequestHandler } from '../request-router.ts';
import type { DaemonRequest, SessionState } from '../types.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { parseReplayInput } from '../../compat/replay-input.ts';
import { computeReplayPlanDigest } from '../../replay/plan-digest.ts';
import { readEffectiveReplayPlanDigestMetadata } from '../handlers/session-replay-runtime-plan.ts';

const mockResolveTargetDevice = vi.mocked(getResolveTargetDeviceMock());

function makeHandler(prefix: string) {
  const sessionStore = makeSessionStore(prefix);
  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    trackDownloadableArtifact: () => 'artifact-id',
  });
  return { sessionStore, handler };
}

function tombstonedSession(name: string): SessionState {
  return {
    name,
    device: { platform: 'apple', id: 'sim-1', name: 'iPhone', kind: 'simulator', booted: true },
    createdAt: Date.now(),
    actions: [],
    saveScriptBoundary: 0,
    repairSourcePath: '/flows/login.ad',
  };
}

function closeRequest(session: string): DaemonRequest {
  return { token: 'test-token', session, command: 'close', positionals: [], flags: {} };
}

test('a command that finds no session but hits a live repair tombstone gets REPAIR_SESSION_EXPIRED', async () => {
  const { sessionStore, handler } = makeHandler('agent-device-router-repair-expired-');
  // The repair session was reaped (idle-reap) leaving a tombstone; the store
  // has no live session by that name.
  sessionStore.writeRepairTombstone(tombstonedSession('repair-x'));

  const response = await handler(closeRequest('repair-x'));

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('REPAIR_SESSION_EXPIRED');
  // Re-run guidance carries the original script path from the tombstone.
  expect(response.error.message).toMatch(/replay \/flows\/login\.ad --save-script/);
});

test('without a tombstone, a missing session still returns a plain SESSION_NOT_FOUND', async () => {
  const { handler } = makeHandler('agent-device-router-no-tombstone-');
  const response = await handler(closeRequest('never-existed'));

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('SESSION_NOT_FOUND');
});

// ADR 0012 decision 6 (BLOCKER 2): a tombstone left by a COMPLETE transaction
// whose commit FAILED at teardown must surface a distinct, actionable
// REPAIR_COMMIT_FAILED — never the generic "reaped before it was finalized"
// REPAIR_SESSION_EXPIRED, which would misleadingly suggest the transaction
// never completed at all.
test('a command hitting a commit-failure tombstone gets REPAIR_COMMIT_FAILED with the real cause, not a generic REPAIR_SESSION_EXPIRED', async () => {
  const { sessionStore, handler } = makeHandler('agent-device-router-commit-failed-');
  sessionStore.writeRepairTombstone(tombstonedSession('repair-commit-fail'), undefined, {
    code: 'COMMAND_FAILED',
    message: 'A prior healed script already exists at /flows/login.healed.ad; ...',
  });

  const response = await handler(closeRequest('repair-commit-fail'));

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('REPAIR_COMMIT_FAILED');
  expect(response.error.code).not.toBe('REPAIR_SESSION_EXPIRED');
  expect(response.error.message).toMatch(/already exists/);
  // Still carries the actionable re-run guidance.
  expect(response.error.message).toMatch(/replay \/flows\/login\.ad --save-script/);
});

test('an expired tombstone does not shadow a missing session', async () => {
  const { sessionStore, handler } = makeHandler('agent-device-router-expired-tombstone-');
  // TTL 0 => already stale.
  sessionStore.writeRepairTombstone(tombstonedSession('repair-y'), 0);

  const response = await handler(closeRequest('repair-y'));

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('SESSION_NOT_FOUND');
});

// ADR 0012 decision 6, R7 (BLOCKER 1): the tombstone translation also covers the
// `replay --from` continuation path — a reaped repair session's continuation
// gets REPAIR_SESSION_EXPIRED, not a REPLAY_DIVERGENCE that slipped past it.
test('a replay --from continuation on a reaped repair session gets REPAIR_SESSION_EXPIRED (not REPLAY_DIVERGENCE)', async () => {
  // Device resolution/readiness is mocked so the router reaches the replay
  // handler's missing-session preflight fast and deterministically.
  const iosDevice: DeviceInfo = {
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone',
    kind: 'simulator',
    booted: true,
  };
  mockResolveTargetDevice.mockResolvedValue(iosDevice);
  const { sessionStore, handler } = makeHandler('agent-device-router-from-expired-');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-router-from-script-'));
  const scriptPath = path.join(root, 'flow.ad');
  fs.writeFileSync(scriptPath, 'open "Demo"\nclick id="a"\n');

  // Compute the plan digest exactly as runReplayScriptFile does (a real agent
  // takes it from the divergence report's resume.planDigest).
  const flags = { platform: 'ios' as const };
  const parsed = parseReplayInput(fs.readFileSync(scriptPath, 'utf8'), flags, {
    sourcePath: scriptPath,
  });
  const digest = computeReplayPlanDigest({
    actions: parsed.actions,
    actionLines: parsed.actionLines,
    actionSourcePaths: parsed.actionSourcePaths,
    metadata: readEffectiveReplayPlanDigestMetadata(flags),
  });

  // The repair session was reaped, leaving a tombstone; no live session exists.
  sessionStore.writeRepairTombstone(tombstonedSession('repair-from'));

  const response = await handler({
    token: 'test-token',
    session: 'repair-from',
    command: 'replay',
    positionals: [scriptPath],
    flags: { ...flags, replayFrom: 2, replayPlanDigest: digest },
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('REPAIR_SESSION_EXPIRED');
  expect(response.error.code).not.toBe('REPLAY_DIVERGENCE');
  expect(response.error.message).toMatch(/replay \/flows\/login\.ad --save-script/);

  fs.rmSync(root, { recursive: true, force: true });
});
