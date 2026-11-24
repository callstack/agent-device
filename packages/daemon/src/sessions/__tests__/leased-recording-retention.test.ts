import fs from 'node:fs';
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
  settleCommittedFileOutputs,
} from '../../resources/artifact-tracking.ts';
import { tryHandleDownloadableArtifactHttpRoute } from '../../server/downloadable-artifact-http.ts';
import { commitRecordingOutputs } from '../recording-outputs.ts';
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
  const envelope = createDurableResourceEnvelope({
    resourceKind: 'screen-recording',
    sessionId: ADDRESS,
    device: { id: session.device.id, family: 'apple', appleOs: 'ios', kind: 'simulator' },
    owner: localRuntimeOwner('apple'),
    fence: { token: 'recording-fence', generation: 1 },
    lifecycle: 'open',
    descriptor: { version: 1, body: { recordingId: 'checkout-flow' } },
    metadata: {
      phase: 'active',
      ...(recordingExport.daemonOwned ? { remoteCaptureOutput: true } : {}),
      ...(options.unleasedProducer && !options.producerTenant
        ? {}
        : { remoteCaptureTenantId: options.producerTenant ?? TENANT }),
      remoteCaptureLease:
        options.leased === false || options.unleasedProducer ? 'unleased' : leaseVerifier(LEASE_ID),
    },
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
  const artifacts = await commitRecordingOutputs(record.envelope, recovery.completion);

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

test.each([undefined, 'former-tenant'])(
  'teardown assigns an unleased recording with producer tenant %s to the session lease tenant',
  async (producerTenant) => {
    const sessionStore = makeSessionStore('agent-device-unleased-recording-');
    publishRecordingSession(sessionStore, remoteRecordingExport(), {
      unleasedProducer: true,
      producerTenant,
    });

    await teardown(sessionStore);

    expect(
      await listDownloadableArtifacts({ tenantId: producerTenant ?? 'tenant-b' }, process.env),
    ).toEqual([]);
    const artifacts = await listDownloadableArtifacts({ tenantId: TENANT }, process.env);
    expect(artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ artifactType: 'screen-recording', filename: 'checkout.mp4' }),
      ]),
    );
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
  try {
    await producer.run(async () => {
      expect(await harness.run(['start'], { tenantId: TENANT }, undefined, remote)).toMatchObject({
        ok: true,
      });
      expect(await harness.run(['stop'], { tenantId: TENANT }, undefined, remote)).toMatchObject({
        ok: true,
      });
    });
    await successor.run(async () => {
      expect(await listDownloadableArtifacts({ tenantId: TENANT }, {})).toEqual([]);
      const stopped = await harness.run(['stop'], { tenantId: 'other' }, undefined, remote);
      if (!stopped.ok) throw new Error(stopped.error.message);
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

async function startSuiteRecording() {
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
  fs.writeFileSync(video, 'leased-suite-recording');
  return { suite, video, stop };
}

test('suite recording staging can wait for an asynchronous copy before publishing', async () => {
  const { stop } = await startSuiteRecording();
  // Hold the asynchronous full-copy path open so other work can run before publication finishes.
  const copy = fs.promises.copyFile;
  let releaseCopy = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseCopy = resolve;
  });
  const staging = vi.spyOn(fs.promises, 'copyFile').mockImplementationOnce(async (...args) => {
    await gate;
    return await copy(...args);
  });
  const synchronousCopy = vi.spyOn(fs, 'copyFileSync');
  const stopping = stop();
  try {
    await vi.waitFor(() => expect(staging).toHaveBeenCalledOnce());
    expect(synchronousCopy).not.toHaveBeenCalled();
    expect(await listDownloadableArtifacts(OWNER, process.env)).toEqual([]);
  } finally {
    releaseCopy();
    staging.mockRestore();
    synchronousCopy.mockRestore();
  }
  const stopped = await stopping;
  expect(stopped).toMatchObject({
    ok: true,
    data: { artifacts: [{ artifactId: expect.any(String) }] },
  });
});

for (const first of ['archive', 'recording']) {
  test(`the producing lease retries after consuming the ${first} first`, async (t) => {
    if (await skipWhenLoopbackUnavailable(t)) return;
    const { suite, video, stop } = await startSuiteRecording();
    const stopped = await stop();
    if (!stopped.ok) throw new Error(stopped.error.message);
    const recording = stopped.data!.artifacts![0]!;
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
        await consumeRecording();
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
  'a transient stat failure on read %d leaves the export retriable',
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
        expect(result).toMatchObject({
          ok: true,
          data: { recording: 'stopped', artifacts: [{ artifactId: expect.any(String) }] },
        });
        expect(fs.readFileSync(source, 'utf8')).toBe('original-export');
      });
    } finally {
      runtime.dispose();
    }
  },
);

test.each([
  ['teardown', false],
  ['teardown', true],
  ['stop', false],
  ['stop', true],
] as const)(
  'failed %s registration expires only the verified original (replaced: %s)',
  async (action, replace) => {
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
    try {
      if (action === 'stop')
        expect(
          await harness.run(['stop'], { tenantId: TENANT }, undefined, { publicNetworkOnly: true }),
        ).toMatchObject({ ok: false });
      await teardown(harness.sessionStore);
      expect(sourceReads).toBe(2);
      expect(await listDownloadableArtifacts({ tenantId: TENANT }, {})).toEqual([]);
    } finally {
      stat.mockRestore();
    }

    await vi.advanceTimersByTimeAsync(14 * 60 * 1000);
    expect(fs.readFileSync(source, 'utf8')).toBe('verified-export');
    if (replace) {
      const unrelated = source + '.replacement';
      fs.writeFileSync(unrelated, 'unrelated-recording');
      fs.renameSync(unrelated, source);
    }
    await vi.advanceTimersByTimeAsync(60 * 1000);
    if (replace) expect(fs.readFileSync(source, 'utf8')).toBe('unrelated-recording');
    else expect(fs.existsSync(source)).toBe(false);
  },
);

test('failed registration of a legacy export without recorded identity leaves its file alone', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const sessionStore = makeSessionStore('recording-legacy-cleanup-');
  const recordingExport = remoteRecordingExport();
  publishRecordingSession(sessionStore, recordingExport);

  const lstat = fs.lstatSync;
  let sourceReads = 0;
  const stat = vi.spyOn(fs, 'lstatSync').mockImplementation((file, options) => {
    if (file === recordingExport.outPath && ++sourceReads === 2) {
      throw Object.assign(new Error('registry stat unavailable'), { code: 'EIO' });
    }
    return lstat(file, options);
  });
  try {
    await teardown(sessionStore);
    expect(sourceReads).toBe(2);
    expect(
      screenRecordingResourceStore.read(
        screenRecordingResourceStore.resolvePath(sessionStore.resolveSessionDir(ADDRESS)),
      ),
    ).toMatchObject({ status: 'decoded', envelope: { lifecycle: 'completed' } });
    expect(await listDownloadableArtifacts(OWNER, {})).toEqual([]);
  } finally {
    stat.mockRestore();
  }
  await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
  expect(fs.readFileSync(recordingExport.outPath, 'utf8')).toBe('video');
  expect(fs.readFileSync(recordingExport.telemetryPath, 'utf8')).toBe('{"events":[]}');
});

test('explicit stop keeps its binding until the advertised sidecar can be verified', async () => {
  const harness = makeRecordRuntimeHarness('recording-sidecar-retry-');
  const finish = harness.runtime.finish.getMockImplementation()!;
  harness.runtime.finish.mockImplementation(async () => {
    const outcome = await finish();
    return {
      ...outcome,
      result: {
        ...outcome.result,
        telemetryPath: deriveRecordingTelemetryPath(outcome.result.outPath),
      },
    };
  });
  const runtime = createRuntimeStateHandle();
  const run = (action: string) =>
    harness.run([action], { tenantId: TENANT }, undefined, { publicNetworkOnly: true });
  try {
    await runtime.run(async () => {
      expect(await run('start')).toMatchObject({ ok: true });
      const video = harness.runtime.start.mock.calls[0]![0].outputPath;
      fs.writeFileSync(video, 'completed-video');
      const active = harness.sessionStore.lookup(harness.sessionName)!.session.screenRecording;
      expect(active).toBeDefined();
      expect(await run('stop')).toMatchObject({
        ok: false,
        error: { code: 'COMMAND_FAILED' },
      });
      expect(harness.sessionStore.lookup(harness.sessionName)!.session.screenRecording).toBe(
        active,
      );
      expect(harness.runtime.forceCleanup).not.toHaveBeenCalled();
      expect(await listDownloadableArtifacts({ tenantId: TENANT }, {})).toEqual([]);

      fs.writeFileSync(deriveRecordingTelemetryPath(video), '{}');
      expect(await run('stop')).toMatchObject({
        ok: true,
        data: {
          artifacts: [{ artifactId: expect.any(String) }, { artifactId: expect.any(String) }],
        },
      });
    });
  } finally {
    runtime.dispose();
  }
});
