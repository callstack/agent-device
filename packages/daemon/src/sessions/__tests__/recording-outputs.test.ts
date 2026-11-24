import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { createRuntimeStateHandle } from '@agent-device/host-kit/runtime-slots';
import {
  IOS_SIMULATOR,
  closeLoopbackServer,
  listenOnLoopback,
  mkdtempForTestSync,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { screenRecordingResourceStore } from '@agent-device/capture-kit/screen-recording-resource-store';
import { finishPendingScreenRecordingProof } from '@agent-device/capture-kit/screen-recording-session-resource';
import { resolveScreenRecordingStopRecovery } from '@agent-device/capture-kit/screen-recording-stop-recovery';
import { DAEMON_HTTP_LEASE_HEADER } from '@agent-device/contracts/daemon-http';
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
  trackDownloadableArtifact,
  leaseVerifier,
  listDownloadableArtifacts,
  openDownloadableArtifact,
  settleCommittedFileOutputs,
} from '../../resources/artifact-tracking.ts';
import { tryHandleDownloadableArtifactHttpRoute } from '../../server/downloadable-artifact-http.ts';
import { collectSuiteRecordingOutputs, commitRecordingOutputs } from '../recording-outputs.ts';
import { teardownSessionResources } from '../session-teardown.ts';
import { makeRecordRuntimeHarness } from '../handlers/__tests__/record-runtime.fixtures.ts';

const TENANT = 'tenant-a';
const LEASE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OWNER = { tenantId: TENANT, leaseId: LEASE_ID };
const ADDRESS = `${TENANT}:checkout-flow`;
const createdPaths: string[] = [];

afterEach(async () => {
  for (const { id } of await listDownloadableArtifacts(OWNER, process.env)) {
    cleanupDownloadableArtifact(id);
  }
  for (const filePath of createdPaths.splice(0)) fs.rmSync(filePath, { force: true });
  vi.useRealTimers();
});

type RecordingExport = {
  outPath: string;
  clientOutPath?: string;
  telemetryPath: string;
  daemonOwned?: true;
};

function remoteRecordingExport(): RecordingExport {
  const outPath = path.join(mkdtempForTestSync('daemon-recording-export-'), 'checkout.mp4');
  return {
    outPath,
    clientOutPath: '/Users/client/checkout.mp4',
    daemonOwned: true,
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
  options: {
    leased?: boolean;
    finishFails?: boolean;
    unleasedProducer?: boolean;
    producerTenant?: string;
    omitTelemetry?: boolean;
    legacy?: boolean;
  } = {},
) {
  const session: SessionState = makeIosSession(ADDRESS, {
    appBundleId: 'com.example.app',
    ...(options.leased === false
      ? {}
      : {
          lease: { leaseId: LEASE_ID, tenantId: TENANT, runId: 'run-1', backend: 'ios-simulator' },
        }),
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
    if (!options.omitTelemetry) fs.writeFileSync(recordingExport.telemetryPath, '{"events":[]}');
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
  const lifetimeId = randomUUID();
  const envelope = createDurableResourceEnvelope({
    resourceKind: 'screen-recording',
    sessionId: ADDRESS,
    device: { id: session.device.id, family: 'apple', appleOs: 'ios', kind: 'simulator' },
    owner: localRuntimeOwner('apple'),
    fence: { token: path.basename(path.dirname(recordingExport.outPath)), generation: 1 },
    lifecycle: 'open',
    descriptor: { version: 1, body: { recordingId: 'checkout-flow' } },
    metadata: {
      phase: 'active',
      ...(recordingExport.daemonOwned
        ? {
            remoteCaptureOutput: true,
            ...(!options.legacy
              ? {
                  remoteCapturePath: recordingExport.outPath,
                  remoteCaptureLifetime: lifetimeId,
                  remoteCaptureReservation: path.basename(path.dirname(recordingExport.outPath)),
                }
              : {}),
          }
        : {}),
      ...(options.unleasedProducer && !options.producerTenant
        ? {}
        : {
            remoteCaptureTenantId:
              options.leased === false ? null : (options.producerTenant ?? TENANT),
          }),
      remoteCaptureLease:
        options.leased === false || options.unleasedProducer ? 'unleased' : leaseVerifier(LEASE_ID),
    },
  });
  session.screenRecording = { handle, envelope };
  screenRecordingResourceStore.write(
    screenRecordingResourceStore.resolvePath(sessionStore.resolveSessionDir(ADDRESS)),
    envelope,
  );
  return { ref: sessionStore.publish(ADDRESS, session, lifetimeId), finish, forceCleanup };
}

async function teardown(sessionStore: SessionStore) {
  await teardownSessionResources({
    appLog: 'already-settled',
    ref: sessionStore.lookup(ADDRESS)!,
    sessionStore,
    platformCleanup: platformResourceCleanupFixture(),
  });
}

test('a leased session teardown keeps the remote recording export downloadable by its lease', async () => {
  const sessionStore = makeSessionStore('agent-device-leased-recording-');
  const recordingExport = remoteRecordingExport();
  publishRecordingSession(sessionStore, recordingExport);

  await teardown(sessionStore);

  const artifacts = await listDownloadableArtifacts(OWNER, process.env);
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
  expect(await listDownloadableArtifacts({ tenantId: 'tenant-b' }, process.env)).toEqual([]);
  expect(await listDownloadableArtifacts({ tenantId: TENANT }, process.env)).toEqual([]);
  expect(
    await listDownloadableArtifacts({ tenantId: TENANT, leaseId: 'f'.repeat(32) }, process.env),
  ).toEqual([]);
});

test('a retained recording is deleted once its lease holder downloads it', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const sessionStore = makeSessionStore('agent-device-leased-recording-download-');
  const recordingExport = remoteRecordingExport();
  publishRecordingSession(sessionStore, recordingExport);
  await teardown(sessionStore);
  const [video] = await listDownloadableArtifacts(OWNER, process.env);
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
    const url = `http://127.0.0.1:${port}/artifacts/${video!.id}`;
    const refused = await fetch(url);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({
      code: 'UNAUTHORIZED',
      reason: 'LEASE_OUTPUT_MISMATCH',
      field: 'leaseId',
    });

    const response = await fetch(url, { headers: { [DAEMON_HTTP_LEASE_HEADER]: LEASE_ID } });

    expect(await response.text()).toBe('video');
    await vi.waitFor(() => expect(fs.existsSync(recordingExport.outPath)).toBe(false));
    expect(
      (await listDownloadableArtifacts(OWNER, process.env)).map((a) => a.artifactType),
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
  expect(await listDownloadableArtifacts(OWNER, process.env)).toHaveLength(2);

  await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

  expect(await listDownloadableArtifacts(OWNER, process.env)).toEqual([]);
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
  expect(await listDownloadableArtifacts(OWNER, process.env)).toEqual([]);
});

test('teardown with a missing sidecar keeps its source and publishes no partial recording', async () => {
  const sessionStore = makeSessionStore('agent-device-leased-recording-unregistered-');
  const recordingExport = remoteRecordingExport();
  publishRecordingSession(sessionStore, recordingExport, { omitTelemetry: true });

  await teardown(sessionStore);

  expect(await listDownloadableArtifacts(OWNER, process.env)).toEqual([]);
  expect(fs.readFileSync(recordingExport.outPath, 'utf8')).toBe('video');
  expect(fs.existsSync(recordingExport.telemetryPath)).toBe(false);
});

test('a record stop replay after a leased teardown serves the artifacts teardown kept', async () => {
  const sessionStore = makeSessionStore('agent-device-leased-recording-replay-');
  publishRecordingSession(sessionStore, remoteRecordingExport());
  await teardown(sessionStore);
  const retained = await listDownloadableArtifacts(OWNER, process.env);

  const recovery = resolveScreenRecordingStopRecovery({
    sessionName: ADDRESS,
    sessionStore,
    device: IOS_SIMULATOR,
  });
  if (recovery.kind !== 'completed') throw new Error(`expected a replay, got ${recovery.kind}`);
  const record = screenRecordingResourceStore.read(
    screenRecordingResourceStore.resolvePath(sessionStore.resolveSessionDir(ADDRESS)),
  );
  if (record.status !== 'decoded') throw new Error('Expected completed recording manifest');
  const artifacts = await commitRecordingOutputs(record.envelope, 'replay');

  expect(artifacts.map((artifact) => artifact.artifactId)).toEqual(retained.map((a) => a.id));
  expect(await listDownloadableArtifacts(OWNER, process.env)).toEqual([
    expect.objectContaining({ id: retained[0]!.id, sessionName: 'checkout-flow' }),
    expect.objectContaining({ id: retained[1]!.id, sessionName: 'checkout-flow' }),
  ]);
  // The replay registers under the lease of the manifest, so it opens no second way to the files.
  expect(await listDownloadableArtifacts({ tenantId: TENANT }, process.env)).toEqual([]);
});

test.each([undefined, '/client/local-copy.mp4'])(
  'a leased teardown leaves a local caller export at its path and registers nothing with client destination %s',
  async (clientOutPath) => {
    const sessionStore = makeSessionStore('agent-device-leased-recording-local-');
    const recordingExport = { ...localRecordingExport(), clientOutPath };
    publishRecordingSession(sessionStore, recordingExport);

    await teardown(sessionStore);

    expect(await listDownloadableArtifacts(OWNER, process.env)).toEqual([]);
    expect(fs.readFileSync(recordingExport.outPath, 'utf8')).toBe('video');
  },
);

test('an unleased session teardown registers nothing for a remote export', async () => {
  const sessionStore = makeSessionStore('agent-device-unleased-recording-');
  const recordingExport = remoteRecordingExport();
  publishRecordingSession(sessionStore, recordingExport, { leased: false });

  await teardown(sessionStore);

  expect(await listDownloadableArtifacts(OWNER, process.env)).toEqual([]);
  expect(await listDownloadableArtifacts({}, process.env)).toEqual([]);
  expect(fs.existsSync(recordingExport.outPath)).toBe(true);
});

test.each([undefined, '/client/downloads/checkout.mp4'])(
  'remote admission retains session-owned recordings after leased teardown with client destination %s',
  async (clientOutPath) => {
    const harness = makeRecordRuntimeHarness('leased-remote-session-recording-', {
      sessionName: ADDRESS,
      lease: {
        backend: 'ios-simulator',
        leaseId: LEASE_ID,
        tenantId: TENANT,
        runId: 'run-1',
      },
    });
    const start = harness.runtime.start.getMockImplementation()!;
    harness.runtime.start.mockImplementation(async (input) => {
      fs.writeFileSync(input.outputPath, 'session-owned-video');
      return await start(input);
    });
    const started = await harness.run(
      ['start'],
      clientOutPath ? { clientArtifactPaths: { outPath: clientOutPath } } : undefined,
      undefined,
      {
        publicNetworkOnly: true,
        admittedLease: {
          leaseId: LEASE_ID,
          tenantId: TENANT,
          runId: 'run-1',
          backend: 'android-instance',
          createdAt: 0,
          heartbeatAt: 0,
          expiresAt: 0,
        },
      },
    );
    expect(started.ok).toBe(true);
    const output = harness.runtime.start.mock.calls[0]![0].outputPath;
    expect(path.dirname(output)).toBe(harness.sessionStore.resolveSessionDir(ADDRESS));

    await teardown(harness.sessionStore);

    const artifacts = await listDownloadableArtifacts(OWNER, process.env);
    expect(artifacts).toEqual([
      expect.objectContaining({
        artifactType: 'screen-recording',
        filename: path.basename(clientOutPath ?? output),
        sessionName: 'checkout-flow',
      }),
    ]);
    expect(await listDownloadableArtifacts({ tenantId: 'tenant-b' }, process.env)).toEqual([]);
    expect(fs.readFileSync(output, 'utf8')).toBe('session-owned-video');
    expect(
      screenRecordingResourceStore.read(
        screenRecordingResourceStore.resolvePath(harness.sessionStore.resolveSessionDir(ADDRESS)),
      ),
    ).toMatchObject({
      status: 'decoded',
      envelope: { lifecycle: 'completed', metadata: { remoteCaptureOutput: true } },
    });
    cleanupDownloadableArtifact(artifacts[0]!.id);
    expect(fs.existsSync(output)).toBe(false);
  },
);

test.each([
  [undefined, true],
  ['former-tenant', true],
  [TENANT, false],
] as const)(
  'teardown preserves proof-less files for legacy producer %s (unleased: %s)',
  async (producerTenant, unleasedProducer) => {
    const sessionStore = makeSessionStore('agent-device-unleased-recording-');
    const output = remoteRecordingExport();
    publishRecordingSession(sessionStore, output, {
      legacy: true,
      unleasedProducer,
      producerTenant,
    });

    await teardown(sessionStore);

    expect(await listDownloadableArtifacts({ tenantId: TENANT }, {})).toEqual([]);
    expect(await listDownloadableArtifacts({ tenantId: producerTenant }, {})).toEqual([]);
    expect(await listDownloadableArtifacts(OWNER, {})).toEqual([]);
    expect(fs.readFileSync(output.outPath, 'utf8')).toBe('video');
  },
);

test('fresh runtime slots can restore an intact recording from its producer manifest', async () => {
  const harness = makeRecordRuntimeHarness('verified-recording-restart-');
  const start = harness.runtime.start.getMockImplementation()!;
  harness.runtime.start.mockImplementation(async (input) => {
    fs.writeFileSync(input.outputPath, 'surviving-original-export');
    return await start(input);
  });
  const producer = createRuntimeStateHandle();
  const successor = createRuntimeStateHandle();
  const missingScope = createRuntimeStateHandle();
  const remote = { publicNetworkOnly: true } as const;
  let originalId: string | undefined;
  try {
    await producer.run(async () => {
      expect(await harness.run(['start'], { tenantId: TENANT }, undefined, remote)).toMatchObject({
        ok: true,
      });
      const stopped = await harness.run(['stop'], { tenantId: TENANT }, undefined, remote);
      if (!stopped.ok) throw new Error(stopped.error.message);
      originalId = stopped.data?.artifacts?.[0]?.artifactId;
      expect(originalId).toBeTypeOf('string');
    });
    producer.dispose();
    await successor.run(async () => {
      expect(await listDownloadableArtifacts({ tenantId: TENANT }, {})).toEqual([]);
      expect(await harness.run(['stop'], { tenantId: 'other' }, undefined, remote)).toMatchObject({
        ok: false,
        error: { code: 'UNAUTHORIZED' },
      });
      const stopped = await harness.run(['stop'], { tenantId: TENANT }, undefined, remote);
      if (!stopped.ok) throw new Error(stopped.error.message);
      expect(stopped.data?.artifacts?.[0]?.artifactId).toBe(originalId);
      settleCommittedFileOutputs(stopped.data?.artifacts, true);
      expect(await listDownloadableArtifacts({ tenantId: 'other' }, {})).toEqual([]);
      expect(await listDownloadableArtifacts({ tenantId: TENANT }, {})).toEqual([
        expect.objectContaining({ artifactType: 'screen-recording' }),
      ]);
    });
    await missingScope.run(async () => {
      const resourcePath = screenRecordingResourceStore.resolvePath(
        harness.sessionStore.resolveSessionDir(harness.sessionName),
      );
      const record = screenRecordingResourceStore.read(resourcePath);
      if (record.status !== 'decoded') throw new Error('Missing verified recording manifest');
      const { remoteCaptureTenantId: _tenant, ...metadata } = record.envelope.metadata!;
      screenRecordingResourceStore.write(resourcePath, { ...record.envelope, metadata });
      expect(await harness.run(['stop'], { tenantId: 'other' }, undefined, remote)).toMatchObject({
        ok: false,
        error: { code: 'UNAUTHORIZED' },
      });
      expect(await listDownloadableArtifacts({ tenantId: 'other' }, {})).toEqual([]);
    });
  } finally {
    missingScope.dispose();
    successor.dispose();
    producer.dispose();
  }
});

test('a failed completion manifest read never returns uncommitted remote paths', async () => {
  const harness = makeRecordRuntimeHarness('recording-completion-proof-io-');
  const run = (action: string) =>
    harness.run([action], { tenantId: TENANT }, undefined, { publicNetworkOnly: true });
  expect(await run('start')).toMatchObject({ ok: true });
  const source = harness.runtime.start.mock.calls[0]![0].outputPath;
  fs.writeFileSync(source, 'completed-video');
  const resourcePath = screenRecordingResourceStore.resolvePath(
    harness.sessionStore.resolveSessionDir(harness.sessionName),
  );
  const lstat = fs.lstatSync;
  let failed = false;
  const inspect = vi.spyOn(fs, 'lstatSync').mockImplementation((file, options) => {
    if (
      file === resourcePath &&
      !failed &&
      fs.readFileSync(resourcePath, 'utf8').includes('"lifecycle":"completed"')
    ) {
      failed = true;
      throw Object.assign(new Error('manifest unavailable'), { code: 'EIO' });
    }
    return lstat(file, options);
  });
  try {
    expect(await run('stop')).toMatchObject({ ok: false, error: { code: 'COMMAND_FAILED' } });
    expect(failed).toBe(true);
    expect(await listDownloadableArtifacts({ tenantId: TENANT }, {})).toEqual([]);
  } finally {
    inspect.mockRestore();
  }
  expect(await run('stop')).toMatchObject({
    ok: true,
    data: { artifacts: [{ artifactId: expect.any(String) }] },
  });
});

test('a transient inspection error preserves the recording and other inventory entries', async () => {
  const harness = makeRecordRuntimeHarness('recording-inspection-retry-');
  const runtime = createRuntimeStateHandle();
  const run = (action: string) =>
    harness.run([action], { tenantId: TENANT }, undefined, { publicNetworkOnly: true });
  try {
    await runtime.run(async () => {
      expect(await run('start')).toMatchObject({ ok: true });
      const video = harness.runtime.start.mock.calls[0]![0].outputPath;
      fs.writeFileSync(video, 'published-video');
      const published = await run('stop');
      expect(published).toMatchObject({
        ok: true,
        data: { artifacts: [{ artifactId: expect.any(String) }] },
      });
      if (!published.ok) throw new Error('Recording was not published');
      const recordingId = published.data?.artifacts?.[0]?.artifactId;
      const healthy = path.join(mkdtempForTestSync('healthy-recording-inventory-'), 'frame.png');
      fs.writeFileSync(healthy, 'healthy artifact');
      const healthyId = trackDownloadableArtifact({
        artifactPath: healthy,
        artifactType: 'screenshot',
        tenantId: TENANT,
      });
      const lstat = fs.lstatSync;
      let failed = false;
      const stat = vi.spyOn(fs, 'lstatSync').mockImplementation((file, options) => {
        if (file === video && !failed) {
          failed = true;
          throw Object.assign(new Error('inspection I/O failed'), { code: 'EIO' });
        }
        return lstat(file, options);
      });
      try {
        const result = await run('stop');
        expect(result).toMatchObject({
          ok: false,
          error: { code: 'COMMAND_FAILED', message: 'Recording output could not be inspected.' },
        });
        expect(fs.readFileSync(video, 'utf8')).toBe('published-video');
        expect(await run('stop')).toEqual(published);

        const reader = { tenantId: TENANT };
        failed = false;
        expect((await listDownloadableArtifacts(reader, {})).map(({ id }) => id)).toEqual([
          healthyId,
        ]);
        expect((await listDownloadableArtifacts(reader, {})).map(({ id }) => id)).toEqual(
          expect.arrayContaining([recordingId, healthyId]),
        );
        expect(fs.readFileSync(video, 'utf8')).toBe('published-video');
      } finally {
        stat.mockRestore();
      }
    });
  } finally {
    runtime.dispose();
  }
});

async function startSuiteRecording(withSidecar = false) {
  const suite = mkdtempForTestSync('archive-recording-retention-');
  const video = path.join(suite, 'recording.mp4');
  const harness = makeRecordRuntimeHarness('archive-recording-stop-', {
    sessionName: ADDRESS,
    suiteCapture: 'remote',
    lease: { backend: 'android-instance', leaseId: LEASE_ID, tenantId: TENANT, runId: 'run-1' },
  });
  const meta = {
    tenantId: TENANT,
    leaseId: LEASE_ID,
    clientArtifactPaths: { artifactsDir: '/client' },
  };
  const internal = {
    publicNetworkOnly: true,
    admittedLease: {
      leaseId: LEASE_ID,
      tenantId: TENANT,
      runId: 'run-1',
      backend: 'android-instance',
      createdAt: 0,
      heartbeatAt: 0,
      expiresAt: 0,
    },
  } as const;
  const stop = () => harness.run(['stop'], meta, undefined, internal);
  expect(await harness.run(['start', video], meta, undefined, internal)).toMatchObject({
    ok: true,
  });
  const source = harness.runtime.start.mock.calls[0]![0].outputPath;
  expect(source.startsWith(suite + path.sep)).toBe(false);
  fs.writeFileSync(source, 'leased-suite-recording');
  if (withSidecar) {
    const telemetryPath = deriveRecordingTelemetryPath(source);
    fs.writeFileSync(telemetryPath, '{}');
    const finish = harness.runtime.finish.getMockImplementation()!;
    harness.runtime.finish.mockImplementation(async () => {
      const outcome = await finish();
      return { ...outcome, result: { ...outcome.result, telemetryPath } };
    });
  }
  const collect = () =>
    collectSuiteRecordingOutputs(harness.sessionStore, harness.sessionStore.lookup(ADDRESS)!);
  return { suite, video, source, stop, collect, harness };
}

test('transient manifest I/O cannot bypass a completed recording lease', async () => {
  const { stop, harness, source } = await startSuiteRecording();
  expect(await stop()).toMatchObject({ ok: true });
  const resourcePath = screenRecordingResourceStore.resolvePath(
    harness.sessionStore.resolveSessionDir(ADDRESS),
  );
  const lstat = fs.lstatSync;
  let fail = true;
  const inspect = vi.spyOn(fs, 'lstatSync').mockImplementation((file, options) => {
    if (file === resourcePath && fail) {
      fail = false;
      throw Object.assign(new Error('manifest unavailable'), { code: 'EIO' });
    }
    return lstat(file, options);
  });
  const unleasedStop = () =>
    harness.run(['stop'], { tenantId: TENANT }, undefined, { publicNetworkOnly: true });
  try {
    expect(await unleasedStop()).toMatchObject({ ok: false, error: { code: 'COMMAND_FAILED' } });
    expect(fail).toBe(false);
    expect(await unleasedStop()).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
    expect(fs.readFileSync(source, 'utf8')).toBe('leased-suite-recording');
    expect(await listDownloadableArtifacts({ tenantId: TENANT }, {})).toEqual([]);
  } finally {
    inspect.mockRestore();
  }
});

test('close persists verified files before retrying an unreadable sidecar', async () => {
  const { harness, source, stop } = await startSuiteRecording(true);
  const sidecar = deriveRecordingTelemetryPath(source);
  const resourcePath = screenRecordingResourceStore.resolvePath(
    harness.sessionStore.resolveSessionDir(ADDRESS),
  );
  const stat = fs.lstatSync;
  const unreadable = (target: string) =>
    vi.spyOn(fs, 'lstatSync').mockImplementation((file, options) => {
      if (file === target) throw Object.assign(new Error(`cannot read ${target}`), { code: 'EIO' });
      return stat(file, options);
    });
  const inspection = unreadable(sidecar);
  try {
    await teardown(harness.sessionStore);
  } finally {
    inspection.mockRestore();
  }
  const pending = screenRecordingResourceStore.read(resourcePath);
  expect(pending).toMatchObject({
    status: 'decoded',
    envelope: {
      lifecycle: 'open',
      metadata: {
        phase: 'export-proof-pending',
        cleanupStatus: 'cleaned',
        remoteCaptureExport: {
          identities: [expect.any(String), null],
        },
      },
    },
  });
  if (pending.status !== 'decoded') throw new Error('Expected a pending export');
  const manifest = unreadable(resourcePath);
  try {
    await expect(
      finishPendingScreenRecordingProof(resourcePath, pending.envelope),
    ).rejects.toMatchObject({
      message: 'Recording ownership proof could not be read.',
      details: { retriable: true },
    });
  } finally {
    manifest.mockRestore();
  }

  fs.writeFileSync(sidecar, 'unproved sidecar');
  await expect(stop()).resolves.toMatchObject({
    ok: false,
    error: { message: 'Recording export is missing producer proof.' },
  });
  fs.writeFileSync(source, 'replacement before retry');
  await expect(stop()).resolves.toMatchObject({
    ok: false,
    error: { message: 'Recording export does not match its stored proof.' },
  });
  expect(await listDownloadableArtifacts(OWNER, {})).toEqual([]);
});

test.each(['expiry', 'disposal'])(
  'stalled recording staging settles on %s before the writer',
  async (end) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const runtime = createRuntimeStateHandle();
    const { video, stop, collect } = await runtime.run(() => startSuiteRecording(true));
    const stopped = await runtime.run(stop);
    if (!stopped.ok) throw new Error(stopped.error.message);
    const artifactId = stopped.data!.artifacts![0]!.artifactId!;
    let enter!: (target: string) => void;
    const entered = new Promise<string>((resolve) => {
      enter = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const copy = fs.promises.copyFile;
    const staging = vi.spyOn(fs.promises, 'copyFile').mockImplementationOnce(async (...args) => {
      enter(String(args[1]));
      await gate;
      await copy(...args);
    });
    let outcome: Awaited<ReturnType<typeof collect>> | undefined;
    const stopping = runtime.run(collect).then((result) => {
      outcome = result;
    });
    try {
      const target = await entered;
      await expect(
        runtime.run(() => openDownloadableArtifact(artifactId, OWNER, {})),
      ).rejects.toMatchObject({
        details: { reason: 'RESOURCE_EXPIRED' },
      });
      if (end === 'disposal') runtime.dispose();
      await vi.advanceTimersByTimeAsync(end === 'expiry' ? 15 * 60 * 1000 : 0);
      expect(outcome).toMatchObject([
        { artifactId: expect.any(String) },
        { artifactId: expect.any(String) },
      ]);
      expect(fs.existsSync(path.dirname(target))).toBe(true);
      expect(staging).toHaveBeenCalledTimes(1);
      release();
      await vi.waitFor(() => expect(fs.existsSync(path.dirname(target))).toBe(false));
      expect(staging).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(video)).toBe(false);
      expect(await runtime.run(() => listDownloadableArtifacts(OWNER, {}))).toEqual([]);
    } finally {
      release();
      await stopping;
      staging.mockRestore();
      runtime.dispose();
    }
  },
);

for (const first of ['archive', 'recording']) {
  test(`the producing lease retries after consuming the ${first} first`, async (t) => {
    if (await skipWhenLoopbackUnavailable(t)) return;
    const { suite, video, source, stop, collect } = await startSuiteRecording();
    const stopped = await stop();
    if (!stopped.ok) throw new Error(stopped.error.message);
    const recording = stopped.data!.artifacts![0]!;
    expect(await listDownloadableArtifacts(OWNER, {})).toEqual([]);
    expect(await collect()).toMatchObject([{ path: video, artifactId: recording.artifactId }]);
    const archiveId = trackDownloadableArtifact({
      artifactPath: suite,
      artifactType: 'test-artifacts',
      tenantId: TENANT,
      leaseVerifier: leaseVerifier(LEASE_ID),
    });
    const server = http.createServer((req, res) => {
      tryHandleDownloadableArtifactHttpRoute({
        req,
        res,
        authorize: async () => ({ tenantId: TENANT }),
        hostEnv: process.env,
      });
    });
    const port = await listenOnLoopback(server);
    const get = (id: string, leaseId: string) =>
      fetch(`http://127.0.0.1:${port}/artifacts/${id}`, {
        headers: { [DAEMON_HTTP_LEASE_HEADER]: leaseId },
      });
    try {
      const consumeArchive = async () => {
        const archive = await get(archiveId, LEASE_ID);
        expect(archive.status).toBe(200);
        expect(
          gunzipSync(Buffer.from(await archive.arrayBuffer())).includes(
            Buffer.from('leased-suite-recording'),
          ),
        ).toBe(true);
        await vi.waitFor(() => expect(fs.existsSync(suite)).toBe(false));
      };
      const consumeRecording = async () => {
        const refused = await get(recording.artifactId!, 'f'.repeat(32));
        expect(refused.status).toBe(401);
        const download = await get(recording.artifactId!, LEASE_ID);
        expect(download.status).toBe(200);
        expect(await download.text()).toBe('leased-suite-recording');
      };
      if (first === 'archive') {
        await consumeArchive();
        expect(await stop()).toMatchObject({ ok: true, data: { artifacts: [recording] } });
        await consumeRecording();
      } else {
        const rm = fs.rmSync;
        const retain = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
          if (target !== source) return rm(target, options);
          throw Object.assign(new Error('unlink interrupted'), { code: 'EIO' });
        });
        try {
          await consumeRecording();
          await vi.waitFor(async () =>
            expect(await listDownloadableArtifacts(OWNER, process.env)).toEqual([
              expect.objectContaining({ id: archiveId }),
            ]),
          );
        } finally {
          retain.mockRestore();
        }
        expect(fs.readFileSync(source, 'utf8')).toBe('leased-suite-recording');
        await vi.waitFor(async () =>
          expect(await listDownloadableArtifacts(OWNER, process.env)).toEqual([
            expect.objectContaining({ id: archiveId }),
          ]),
        );
        expect(fs.readFileSync(video, 'utf8')).toBe('leased-suite-recording');
        const expired = { ok: false, error: { details: { reason: 'RESOURCE_EXPIRED' } } };
        expect(await stop()).toMatchObject(expired);
        const restarted = createRuntimeStateHandle();
        try {
          expect(await restarted.run(stop)).toMatchObject(expired);
        } finally {
          restarted.dispose();
        }
        await consumeArchive();
      }
      await vi.waitFor(async () =>
        expect(await listDownloadableArtifacts(OWNER, process.env)).toEqual([]),
      );
    } finally {
      cleanupDownloadableArtifact(archiveId);
      cleanupDownloadableArtifact(recording.artifactId!);
      await closeLoopbackServer(server);
    }
  });
}

test.each([1, 2])(
  'a transient stat failure on read %d permits retry only with producer proof',
  async (failureRead) => {
    const harness = makeRecordRuntimeHarness('recording-verification-retry-');
    const runtime = createRuntimeStateHandle();
    const start = harness.runtime.start.getMockImplementation()!;
    harness.runtime.start.mockImplementation(async (input) => {
      fs.writeFileSync(input.outputPath, 'original-export');
      return await start(input);
    });
    const remote = { publicNetworkOnly: true } as const;
    try {
      await runtime.run(async () => {
        const run = async (action: string) =>
          await harness.run([action], { tenantId: TENANT }, undefined, remote);
        expect(await run('start')).toMatchObject({ ok: true });
        const source = harness.runtime.start.mock.calls[0]![0].outputPath;
        const lstat = fs.lstatSync;
        let sourceReads = 0;
        const stat = vi.spyOn(fs, 'lstatSync').mockImplementation((file, options) => {
          if (file === source && ++sourceReads === failureRead) {
            throw Object.assign(new Error('transient stat failure'), { code: 'EIO' });
          }
          return lstat(file, options);
        });
        try {
          expect(await run('stop')).toMatchObject({ ok: false });
          expect(sourceReads).toBe(failureRead);
          expect(await listDownloadableArtifacts({ tenantId: TENANT }, {})).toEqual([]);
        } finally {
          stat.mockRestore();
        }
        const result = await run('stop');
        expect(result).toMatchObject(
          failureRead === 1
            ? { ok: false, error: { message: 'Recording export is missing producer proof.' } }
            : {
                ok: true,
                data: { recording: 'stopped', artifacts: [{ artifactId: expect.any(String) }] },
              },
        );
        expect(fs.readFileSync(source, 'utf8')).toBe('original-export');
      });
    } finally {
      runtime.dispose();
    }
  },
);

test.each([
  ['teardown', false, 'timer'],
  ['teardown', true, 'timer'],
  ['stop', false, 'timer'],
  ['stop', true, 'timer'],
  ['stop', false, 'replay'],
  ['stop', true, 'replay'],
] as const)(
  'failed %s registration expires only the verified original (replaced: %s) on %s',
  async (action, replace, expiry) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const harness = makeRecordRuntimeHarness('recording-cleanup-expiry-', { sessionName: ADDRESS });
    const start = harness.runtime.start.getMockImplementation()!;
    harness.runtime.start.mockImplementation(async (input) => {
      fs.writeFileSync(input.outputPath, 'verified-export');
      return await start(input);
    });
    expect(
      await harness.run(['start'], { tenantId: TENANT }, undefined, { publicNetworkOnly: true }),
    ).toMatchObject({ ok: true });
    const source = harness.runtime.start.mock.calls[0]![0].outputPath;
    const lstat = fs.lstatSync;
    let sourceReads = 0;
    const stat = vi.spyOn(fs, 'lstatSync').mockImplementation((file, options) => {
      if (file === source && ++sourceReads === 2)
        throw Object.assign(new Error('registry stat unavailable'), { code: 'EIO' });
      return lstat(file, options);
    });
    const runtime = createRuntimeStateHandle();
    try {
      await runtime.run(async () => {
        if (action === 'stop')
          expect(
            await harness.run(['stop'], { tenantId: TENANT }, undefined, {
              publicNetworkOnly: true,
            }),
          ).toMatchObject({ ok: false });
        await teardown(harness.sessionStore);
        expect(sourceReads).toBe(2);
        expect(await listDownloadableArtifacts({ tenantId: TENANT }, {})).toEqual([]);
      });
    } finally {
      stat.mockRestore();
      runtime.dispose();
    }

    await vi.advanceTimersByTimeAsync(14 * 60 * 1000);
    expect(fs.readFileSync(source, 'utf8')).toBe('verified-export');
    if (replace) {
      const unrelated = source + '.replacement';
      fs.writeFileSync(unrelated, 'unrelated-recording');
      fs.renameSync(unrelated, source);
    }
    if (expiry === 'timer') {
      await vi.advanceTimersByTimeAsync(60 * 1000);
    } else {
      // Move the clock without dispatching the old runtime's timer. The manifest has the deadline.
      vi.setSystemTime(Date.now() + 60 * 1000);
      const successor = createRuntimeStateHandle();
      try {
        expect(
          await successor.run(() =>
            harness.run(['stop'], { tenantId: TENANT }, undefined, { publicNetworkOnly: true }),
          ),
        ).toMatchObject({ ok: false, error: { details: { reason: 'RESOURCE_EXPIRED' } } });
      } finally {
        successor.dispose();
      }
    }
    if (replace) expect(fs.readFileSync(source, 'utf8')).toBe('unrelated-recording');
    else expect(fs.existsSync(source)).toBe(false);
  },
);
