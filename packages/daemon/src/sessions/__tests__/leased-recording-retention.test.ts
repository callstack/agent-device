import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import {
  IOS_SIMULATOR,
  closeLoopbackServer,
  listenOnLoopback,
  mkdtempForTestSync,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { screenRecordingResourceStore } from '@agent-device/capture-kit/screen-recording-resource-store';
import { resolveScreenRecordingStopRecovery } from '@agent-device/capture-kit/screen-recording-stop-recovery';
import { buildRemoteTempArtifactPath } from '@agent-device/contracts/daemon-http';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type {
  ScreenRecordingCompletion,
  ScreenRecordingLiveHandle,
} from '@agent-device/contracts/screen-recording-runtime';
import { deriveRecordingTelemetryPath } from '@agent-device/capture-kit/recording-telemetry';
import { makeIosSession } from '../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { platformResourceCleanupFixture } from '../../__tests__/support/platform-resource-cleanup-fixture.ts';
import type { SessionStore } from '../../core/session-store.ts';
import type { SessionState } from '../../core/session-state.ts';
import {
  cleanupDownloadableArtifact,
  listDownloadableArtifacts,
  trackDownloadableArtifact,
} from '../../resources/artifact-tracking.ts';
import { tryHandleDownloadableArtifactHttpRoute } from '../../server/downloadable-artifact-http.ts';
import { finalizeDaemonResponse } from '../../server/request-finalization.ts';
import { buildRecordingStopResponse } from '../handlers/record-runtime-response.ts';
import { teardownSessionResources } from '../session-teardown.ts';

const tracking = vi.hoisted(() => ({ failOnCall: 0, calls: 0 }));
vi.mock('../../resources/artifact-tracking.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../resources/artifact-tracking.ts')>();
  return {
    ...actual,
    trackDownloadableArtifact: (
      ...args: Parameters<typeof actual.trackDownloadableArtifact>
    ): string => {
      tracking.calls += 1;
      if (tracking.calls === tracking.failOnCall) throw new Error('registration failed');
      return actual.trackDownloadableArtifact(...args);
    },
  };
});

const TENANT = 'tenant-a';
const ADDRESS = `${TENANT}:checkout-flow`;
const createdPaths: string[] = [];

afterEach(async () => {
  for (const { id } of await listDownloadableArtifacts(TENANT, process.env)) {
    cleanupDownloadableArtifact(id);
  }
  for (const filePath of createdPaths.splice(0)) fs.rmSync(filePath, { force: true });
  tracking.failOnCall = 0;
  tracking.calls = 0;
  vi.useRealTimers();
});

type RecordingExport = { outPath: string; clientOutPath?: string; telemetryPath: string };

function remoteRecordingExport(): RecordingExport {
  const outPath = buildRemoteTempArtifactPath('recording', 'mp4');
  return {
    outPath,
    clientOutPath: '/Users/client/checkout.mp4',
    telemetryPath: deriveRecordingTelemetryPath(outPath),
  };
}

function localRecordingExport(): RecordingExport {
  const outPath = path.join(mkdtempForTestSync('agent-device-local-recording-'), 'checkout.mp4');
  return { outPath, telemetryPath: deriveRecordingTelemetryPath(outPath) };
}

/** Publishes a session whose live recording finishes into `recordingExport`, or fails to stop. */
function publishRecordingSession(
  sessionStore: SessionStore,
  recordingExport: RecordingExport,
  options: { leased?: boolean; finishFails?: boolean } = {},
) {
  const session: SessionState = makeIosSession(ADDRESS, {
    appBundleId: 'com.example.app',
    ...(options.leased === false
      ? {}
      : { lease: { leaseId: 'lease-1', tenantId: TENANT, runId: 'run-1' } }),
  });
  const completion: ScreenRecordingCompletion = {
    backend: 'simctl recordVideo',
    outPath: recordingExport.outPath,
    ...(recordingExport.clientOutPath ? { clientOutPath: recordingExport.clientOutPath } : {}),
    telemetryPath: recordingExport.telemetryPath,
    startedAt: Date.now() - 5_000,
    completedAt: Date.now(),
    scope: 'app',
    showTouches: true,
    recordOnlySession: false,
  };
  const finish = vi.fn(async () => {
    if (options.finishFails) {
      return {
        status: 'cleanup-pending',
        reason: 'transport-failed',
        message: 'failed to stop recording',
      } as const;
    }
    createdPaths.push(recordingExport.outPath, recordingExport.telemetryPath);
    fs.writeFileSync(recordingExport.outPath, 'video');
    fs.writeFileSync(recordingExport.telemetryPath, '{"events":[]}');
    return { status: 'completed', result: completion } as const;
  });
  const forceCleanup = vi.fn(async () => ({ status: 'cleaned' }) as const);
  const handle: ScreenRecordingLiveHandle = {
    inspect: () => ({ ...completion, gestureEvents: [] }),
    appendGestureEvents: () => {},
    setTouchReferenceFrame: () => {},
    setRunnerSessionId: () => {},
    invalidate: () => {},
    finish,
    forceCleanup,
    [Symbol.asyncDispose]: async () => {},
  };
  const envelope = createDurableResourceEnvelope({
    resourceKind: 'screen-recording',
    sessionId: ADDRESS,
    device: { id: session.device.id, family: 'apple', appleOs: 'ios', kind: 'simulator' },
    owner: localRuntimeOwner('apple'),
    fence: { token: 'recording-fence', generation: 1 },
    lifecycle: 'open',
    descriptor: { version: 1, body: { recordingId: 'checkout-flow' } },
    metadata: { phase: 'active' },
  });
  session.screenRecording = { handle, envelope };
  screenRecordingResourceStore.write(
    screenRecordingResourceStore.resolvePath(sessionStore.resolveSessionDir(ADDRESS)),
    envelope,
  );
  return { ref: sessionStore.publish(ADDRESS, session), finish, forceCleanup };
}

async function teardown(sessionStore: SessionStore) {
  await teardownSessionResources({
    appLog: 'already-settled',
    ref: sessionStore.lookup(ADDRESS)!,
    sessionStore,
    platformCleanup: platformResourceCleanupFixture(),
  });
}

test('a leased session teardown keeps the remote recording export downloadable by its tenant', async () => {
  const sessionStore = makeSessionStore('agent-device-leased-recording-');
  const recordingExport = remoteRecordingExport();
  publishRecordingSession(sessionStore, recordingExport);

  await teardown(sessionStore);

  const artifacts = await listDownloadableArtifacts(TENANT, process.env);
  expect(artifacts).toEqual([
    expect.objectContaining({
      artifactType: 'screen-recording',
      filename: 'checkout.mp4',
      sessionName: 'checkout-flow',
    }),
    expect.objectContaining({
      artifactType: 'screen-recording-telemetry',
      filename: path.basename(recordingExport.telemetryPath),
      sessionName: 'checkout-flow',
    }),
  ]);
  expect(await listDownloadableArtifacts('tenant-b', process.env)).toEqual([]);
});

test('a retained recording is deleted once its tenant downloads it', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const sessionStore = makeSessionStore('agent-device-leased-recording-download-');
  const recordingExport = remoteRecordingExport();
  publishRecordingSession(sessionStore, recordingExport);
  await teardown(sessionStore);
  const [video] = await listDownloadableArtifacts(TENANT, process.env);
  const server = http.createServer((req, res) => {
    tryHandleDownloadableArtifactHttpRoute({
      req,
      res,
      authorize: async () => ({ tenantId: TENANT }),
      hostEnv: process.env,
    });
  });
  const port = await listenOnLoopback(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/artifacts/${video!.id}`);

    expect(await response.text()).toBe('video');
    await vi.waitFor(() => expect(fs.existsSync(recordingExport.outPath)).toBe(false));
    expect(
      (await listDownloadableArtifacts(TENANT, process.env)).map((a) => a.artifactType),
    ).toEqual(['screen-recording-telemetry']);
  } finally {
    await closeLoopbackServer(server);
  }
});

test('a retained recording nobody downloads is deleted when it expires', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const sessionStore = makeSessionStore('agent-device-leased-recording-expiry-');
  const recordingExport = remoteRecordingExport();
  publishRecordingSession(sessionStore, recordingExport);
  await teardown(sessionStore);
  expect(await listDownloadableArtifacts(TENANT, process.env)).toHaveLength(2);

  await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

  expect(await listDownloadableArtifacts(TENANT, process.env)).toEqual([]);
  expect(fs.existsSync(recordingExport.outPath)).toBe(false);
  expect(fs.existsSync(recordingExport.telemetryPath)).toBe(false);
});

test('a failed teardown finish runs forced cleanup and keeps nothing for download', async () => {
  const sessionStore = makeSessionStore('agent-device-leased-recording-failed-');
  const { forceCleanup } = publishRecordingSession(sessionStore, remoteRecordingExport(), {
    finishFails: true,
  });

  await expect(teardown(sessionStore)).rejects.toThrow(/recording: .*failed to stop recording/);

  expect(forceCleanup).toHaveBeenCalledOnce();
  expect(await listDownloadableArtifacts(TENANT, process.env)).toEqual([]);
});

test('a leased teardown that cannot register the export deletes it instead of leaking it', async () => {
  tracking.failOnCall = 2;
  const sessionStore = makeSessionStore('agent-device-leased-recording-unregistered-');
  const recordingExport = remoteRecordingExport();
  publishRecordingSession(sessionStore, recordingExport);

  await teardown(sessionStore);

  expect(await listDownloadableArtifacts(TENANT, process.env)).toEqual([]);
  expect(fs.existsSync(recordingExport.outPath)).toBe(false);
  expect(fs.existsSync(recordingExport.telemetryPath)).toBe(false);
});

test('a record stop replay after a leased teardown serves the artifacts teardown kept', async () => {
  const sessionStore = makeSessionStore('agent-device-leased-recording-replay-');
  publishRecordingSession(sessionStore, remoteRecordingExport());
  await teardown(sessionStore);
  const retained = await listDownloadableArtifacts(TENANT, process.env);

  const recovery = resolveScreenRecordingStopRecovery({
    sessionName: ADDRESS,
    sessionStore,
    device: IOS_SIMULATOR,
  });
  if (recovery.kind !== 'completed') throw new Error(`expected a replay, got ${recovery.kind}`);
  const replayed = finalizeDaemonResponse(
    {
      token: 't',
      session: ADDRESS,
      command: 'record',
      positionals: ['stop'],
      flags: {},
      meta: { tenantId: TENANT },
    },
    buildRecordingStopResponse(recovery.completion),
    trackDownloadableArtifact,
  );

  expect(replayed.ok && replayed.data?.artifacts?.map((a) => a.artifactId)).toEqual(
    retained.map((a) => a.id),
  );
  expect(await listDownloadableArtifacts(TENANT, process.env)).toEqual([
    expect.objectContaining({ id: retained[0]!.id, sessionName: 'checkout-flow' }),
    expect.objectContaining({ id: retained[1]!.id, sessionName: 'checkout-flow' }),
  ]);
});

test('a leased teardown leaves a local caller export at its path and registers nothing', async () => {
  const sessionStore = makeSessionStore('agent-device-leased-recording-local-');
  const recordingExport = localRecordingExport();
  publishRecordingSession(sessionStore, recordingExport);

  await teardown(sessionStore);

  expect(await listDownloadableArtifacts(TENANT, process.env)).toEqual([]);
  expect(fs.readFileSync(recordingExport.outPath, 'utf8')).toBe('video');
});

test('an unleased session teardown registers nothing for a remote export', async () => {
  const sessionStore = makeSessionStore('agent-device-unleased-recording-');
  const recordingExport = remoteRecordingExport();
  publishRecordingSession(sessionStore, recordingExport, { leased: false });

  await teardown(sessionStore);

  expect(await listDownloadableArtifacts(TENANT, process.env)).toEqual([]);
  expect(await listDownloadableArtifacts(undefined, process.env)).toEqual([]);
  expect(fs.existsSync(recordingExport.outPath)).toBe(true);
});
