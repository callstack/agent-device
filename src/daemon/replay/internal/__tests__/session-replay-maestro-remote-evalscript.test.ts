import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { createScreenRecordingAdmissionLedger } from '@agent-device/capture-kit/screen-recording-admission-ledger';
import { LeaseRegistry } from '../../../lease-registry.ts';
import { platformResourceCleanup } from '../../../../platform-runtime-resource-cleanup.ts';
import { SessionStore } from '../../../session-store.ts';
import { makeIosSession } from '../../../../__tests__/test-utils/session-factories.ts';
import { maestroScriptSourceBundleFor } from '../../../../__tests__/test-utils/replay-script-source.ts';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';
import type { DaemonRequest } from '../../../daemon-request.ts';
import {
  unavailableBindDevice,
  unavailableBindExactDevice,
} from '../../../__tests__/test-device-runtime-gateway.ts';
import {
  handleReplayCommand,
  handleReplayTestCommand,
} from '../../../handlers/session-replay-command.ts';
import type { SessionCommandParams } from '../../../handlers/session-command-input.ts';
import * as maestro from '@agent-device/maestro';

const spy = vi.spyOn(maestro, 'executeMaestroFlow');

const maestroFlow = [
  'appId: com.example.app',
  '---',
  '- evalScript: ${output.sum = 1 + 2}',
  '',
].join('\n');

function writeFlow(root: string, name: string): string {
  const filePath = path.join(root, name);
  fs.writeFileSync(filePath, maestroFlow);
  return filePath;
}

function engineTrustFlags(): boolean[] {
  return spy.mock.calls.map(([, , options]) => {
    const { trustedScripts } = options as { trustedScripts?: boolean };
    if (typeof trustedScripts !== 'boolean') throw new Error('Expected engine trust flag');
    return trustedScripts;
  });
}

async function runWithNetworkFlag(publicNetworkOnly: boolean | undefined) {
  const root = mkdtempForTestSync('agent-device-maestro-remote-wire-');
  const flowPath = writeFlow(root, 'flow.yaml');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  sessionStore.set('default', makeIosSession('default'));

  const req = {
    token: 'test-token',
    session: 'default',
    command: 'replay',
    positionals: [flowPath],
    flags: {
      platform: 'ios',
      replayBackend: 'maestro',
      replayScriptSource: await maestroScriptSourceBundleFor(flowPath),
    },
    ...(publicNetworkOnly === true ? { internal: { publicNetworkOnly: true } } : {}),
    meta: { requestId: `req-maestro-wire-${publicNetworkOnly}` },
  } as unknown as DaemonRequest;

  spy.mockReset();
  spy.mockResolvedValue({ ok: true, replayed: 1, planDigest: 'test', startIndex: 0 } as never);

  // Drive the real `replay` handler so the request-private → command-input
  // mapping (`req.internal.publicNetworkOnly → command.publicNetworkOnly`) is on
  // the asserted path: dropping it in the handler must fail this test, since an
  // unset field reads as trusted and a remote flow would run evalScript.
  const response = await handleReplayCommand({
    req,
    sessionName: 'default',
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async () => ({ ok: true, data: {} }) as never,
    leaseRegistry: new LeaseRegistry(),
    reconcileOrphanedDeviceClaim: async () => ({
      status: 'retained' as const,
      reason: 'test' as const,
    }),
  });

  if (!response) throw new Error('Expected replay response');
  expect(response.ok).toBe(true);
  return engineTrustFlags();
}

async function runWithTestNetworkFlag(publicNetworkOnly: boolean | undefined) {
  const root = mkdtempForTestSync('agent-device-maestro-remote-test-');
  const firstPath = writeFlow(root, '01-flow.yaml');
  const secondPath = writeFlow(root, '02-flow.yaml');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));

  const req = {
    token: 'test-token',
    session: 'default',
    command: 'test',
    positionals: [firstPath, secondPath],
    flags: {
      platform: 'ios',
      replayBackend: 'maestro',
      replayScriptSources: await Promise.all([
        maestroScriptSourceBundleFor(firstPath),
        maestroScriptSourceBundleFor(secondPath),
      ]),
    },
    ...(publicNetworkOnly === true ? { internal: { publicNetworkOnly: true } } : {}),
    meta: { requestId: `req-maestro-test-wire-${publicNetworkOnly}` },
  } as unknown as DaemonRequest;

  spy.mockReset();
  spy.mockResolvedValue({ ok: true, replayed: 1, planDigest: 'test', startIndex: 0 } as never);

  // Drive the real `replay test` handler and suite scheduler so the handler mapping and the
  // per-case forwarding of `publicNetworkOnly` are both on the asserted engine path.
  const response = await handleReplayTestCommand({
    req,
    sessionName: 'default',
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    invoke: async () => ({ ok: true, data: {} }) as never,
    reconcileOrphanedDeviceClaim: async () => ({
      status: 'retained' as const,
      reason: 'test' as const,
    }),
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
  } as unknown as SessionCommandParams);

  if (!response) throw new Error('Expected replay test response');
  expect(response).toMatchObject({ ok: true, data: { total: 2, executed: 2, passed: 2 } });
  return engineTrustFlags();
}

describe('remote Maestro evalScript trust wiring', () => {
  // Proves the remote HTTP surface reaches the engine as trustedScripts:false.
  // The engine side (process/fs/child-process/network/budget matrix in
  // packages/maestro/src/internal/__tests__/engine.test.ts) proves false refuses
  // before vm evaluation — together they prove remote evalScript never runs.
  test('remote HTTP (publicNetworkOnly) forwards trustedScripts:false so the engine refuses before vm', async () => {
    const trustFlags = await runWithNetworkFlag(true);
    expect(trustFlags).toEqual([false]);
  });

  test('local flow does not forward trustedScripts:false', async () => {
    const trustFlags = await runWithNetworkFlag(undefined);
    expect(trustFlags).toEqual([true]);
  });

  test('remote replay test forwards trustedScripts:false to each Maestro attempt', async () => {
    const trustFlags = await runWithTestNetworkFlag(true);
    expect(trustFlags).toEqual([false, false]);
  });

  test('local replay test does not forward trustedScripts:false', async () => {
    const trustFlags = await runWithTestNetworkFlag(undefined);
    expect(trustFlags).toEqual([true, true]);
  });
});
