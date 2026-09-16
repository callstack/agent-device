import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type {
  HostAudioCaptureProcess,
  HostSystemAudioCaptureHost,
} from '@agent-device/contracts/audio-probe-runtime-host';
import type { HostCommandResult } from '@agent-device/contracts/platform-runtime-host';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { createHostAudioProbeCaptureOperations } from '../../audio-probe-runtime.ts';
import { createAudioProbeAdmissionLedger } from '../audio-probe-admission-ledger.ts';
import { audioProbeResourceStore } from '../audio-probe-resource-store.ts';
import {
  adoptStartedAudioProbe,
  audioProbeDurableResource,
  finishLiveAudioProbe,
} from '../audio-probe-session-resource.ts';
import type { DurableCaptureSessionState } from '../session-state-slice.ts';
import {
  makeCaptureAdmissionSessionStore,
  type CaptureAdmissionSessionStore,
} from './session-store.fixtures.ts';

const device = {
  platform: 'apple' as const,
  appleOs: 'macos' as const,
  id: 'macos-host',
  name: 'macOS',
  kind: 'device' as const,
};
const fence = { token: 'fence-1', generation: 1 };
const marker = { pid: 4242, startTime: 'boot+1', command: 'helper' };

/**
 * ADR 0024 rule 6 for audio-probe: the whole capture is the status file, and the kind's cleanup
 * terminates the sampler by exact identity without touching it. A sampler that died mid-capture is
 * never revived, so what a failed finish must still guarantee is the termination and a record that
 * lets the next probe start.
 */
test('audio-probe disposes on a failed finish because terminating the helper is what remains and the status file survives it', async () => {
  const sessionName = 'session';
  const sessionStore = makeCaptureAdmissionSessionStore<DurableCaptureSessionState>(
    'audio-probe-failed-finish-',
  );
  const session: DurableCaptureSessionState = {};
  sessionStore.set(sessionName, session);
  const statusPath = path.join(sessionStore.resolveSessionDir(sessionName), 'audio-probe.json');
  const terminate = vi.fn(async () => {});
  let resolveExit!: (result: HostCommandResult) => void;
  const process: HostAudioCaptureProcess = {
    marker,
    terminate,
    wait: new Promise<HostCommandResult>((resolve) => {
      resolveExit = resolve;
    }),
  };
  const host: HostSystemAudioCaptureHost = {
    info: {
      source: 'system-audio',
      backend: 'macos-screencapturekit',
      sourceCount: 1,
      notes: () => [],
    },
    start: async () => {
      await fs.mkdir(path.dirname(statusPath), { recursive: true });
      await fs.writeFile(
        statusPath,
        JSON.stringify({ state: 'running', rmsDbfs: [-10], peakDbfs: [-5], sampleCount: 1 }),
      );
      return process;
    },
    inspectProcess: async () => 'missing',
    terminateProcess: async () => 'already-missing',
  };
  const started = await createHostAudioProbeCaptureOperations({
    host,
    device,
    owner: localRuntimeOwner('apple'),
  }).audioProbeStart({
    sessionId: sessionName,
    statusPath,
    durationMs: 10_000,
    bucketMs: 1_000,
    fence,
  });
  await adoptStartedAudioProbe({
    admissionLedger: createAudioProbeAdmissionLedger(),
    session,
    sessionName,
    sessionStore,
    device,
    owner: localRuntimeOwner('apple'),
    fence,
    pendingHandle: started.pendingHandle,
    envelope: started.envelope,
    throwIfCanceled: () => {},
  });
  resolveExit({ stdout: '', stderr: 'sampler died before its final checkpoint', exitCode: 1 });
  await new Promise((resolve) => setImmediate(resolve));

  await expect(
    finishLiveAudioProbe({
      intent: 'capture',
      session: sessionStore.get(sessionName) ?? session,
      sessionName,
      sessionStore,
    }),
  ).rejects.toThrow('helper exited before completing the capture');

  expect(terminate).toHaveBeenCalledOnce();
  await expect(fs.readFile(statusPath, 'utf8')).resolves.toContain('"state":"running"');
  expect(audioProbeResourceStore.read(resourcePath(sessionStore, sessionName))).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed' },
  });
  expect(() =>
    audioProbeDurableResource.createNextFence({
      admissionLedger: createAudioProbeAdmissionLedger(),
      resourcePath: resourcePath(sessionStore, sessionName),
      device,
    }),
  ).not.toThrow();
});

function resourcePath(
  sessionStore: CaptureAdmissionSessionStore<DurableCaptureSessionState>,
  sessionName: string,
) {
  return audioProbeResourceStore.resolvePath(sessionStore.resolveSessionDir(sessionName));
}
