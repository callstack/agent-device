/**
 * #2663 PR A: the daemon handler is the ONLY producer of `ReplayCommand`, and the sole place
 * that turns the request-private `internal.publicNetworkOnly` into the Maestro script-trust
 * command input. If a later edit — such as the PR B move — drops the mapping on either entry
 * point, the field reads absent, the engine trusts the flow, and a remote HTTP replay would run
 * `evalScript`. These assertions pin the mapping for BOTH `replay` and `replay test` so a dropped
 * line fails here instead of failing open. The engine-level assertions for both routes live in
 * `session-replay-maestro-remote-evalscript.test.ts`, routed through these handlers.
 */
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { LeaseRegistry } from '../../lease-registry.ts';
import { platformResourceCleanup } from '../../../platform-runtime-resource-cleanup.ts';
import { createScreenRecordingAdmissionLedger } from '@agent-device/capture-kit/screen-recording-admission-ledger';
import {
  unavailableBindDevice,
  unavailableBindExactDevice,
} from '../../__tests__/test-device-runtime-gateway.ts';
import type { ReplayCommand, ReplayTestCommand } from '../../replay/internal/command-types.ts';
import type { SessionCommandParams } from '../session-command-input.ts';
import { makeSessionStore } from './session-test-harness.ts';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';

// Hoisted: the handler reaches the replay façade through a daemon module that this file's own
// imports pull in, so the factory below runs before a plain `const` would be initialized.
const { runReplayCommand, runReplayTestCommand } = vi.hoisted(() => ({
  runReplayCommand: vi.fn(async (_command: ReplayCommand) => ({
    ok: true as const,
    data: {},
  })),
  runReplayTestCommand: vi.fn(async (_command: ReplayTestCommand) => ({
    ok: true as const,
    data: {},
  })),
}));

// The doubles replace only the two entry points. The handler also binds the session and splits the
// request through this façade, and those bindings are part of what is pinned here, so the rest of
// the module stays real.
vi.mock('../../replay/index.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../replay/index.ts')>()),
  runReplayCommand,
  runReplayTestCommand,
}));

const { handleReplayCommand, handleReplayTestCommand } =
  await import('../session-replay-command.ts');

beforeEach(() => {
  runReplayCommand.mockClear();
  runReplayTestCommand.mockClear();
});

function baseParams(
  command: string,
  internal?: { publicNetworkOnly?: true },
): SessionCommandParams {
  const root = mkdtempForTestSync('agent-device-replay-trust-');
  return {
    req: {
      token: 'token',
      session: 'default',
      command,
      positionals: [path.join(root, 'flow.ad')],
      flags: { platform: 'ios' },
      ...(internal ? { internal } : {}),
      meta: { cwd: root, requestId: `replay-trust-${command}` },
    },
    sessionName: 'default',
    logPath: path.join(root, 'daemon.log'),
    sessionStore: makeSessionStore(),
    leaseRegistry: new LeaseRegistry(),
    invoke: async () => ({ ok: true as const, data: {} }),
    reconcileOrphanedDeviceClaim: async () => ({
      status: 'retained' as const,
      reason: 'test' as const,
    }),
  } as unknown as SessionCommandParams;
}

function testParams(internal?: { publicNetworkOnly?: true }): SessionCommandParams {
  return {
    ...baseParams('test', internal),
    bindDevice: unavailableBindDevice,
    bindExactDevice: unavailableBindExactDevice,
    inspectFacts: async () => undefined,
    screenRecordingAdmissionLedger: createScreenRecordingAdmissionLedger(),
    requestScope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
    retainDeviceExecutionLock: async () => {},
    throwIfCanceled: () => {},
    platformResourceCleanup,
  } as unknown as SessionCommandParams;
}

test('replay handler maps internal.publicNetworkOnly to the command input', async () => {
  await handleReplayCommand(baseParams('replay', { publicNetworkOnly: true }));
  expect(runReplayCommand.mock.calls[0]?.[0].publicNetworkOnly).toBe(true);
});

test('replay handler marks a local request as trusted', async () => {
  await handleReplayCommand(baseParams('replay'));
  expect(runReplayCommand.mock.calls[0]?.[0].publicNetworkOnly).toBeUndefined();
});

test('replay test handler maps internal.publicNetworkOnly to the command input', async () => {
  await handleReplayTestCommand(testParams({ publicNetworkOnly: true }));
  expect(runReplayTestCommand.mock.calls[0]?.[0].publicNetworkOnly).toBe(true);
});

test('replay test handler marks a local request as trusted', async () => {
  await handleReplayTestCommand(testParams());
  expect(runReplayTestCommand.mock.calls[0]?.[0].publicNetworkOnly).toBeUndefined();
});
