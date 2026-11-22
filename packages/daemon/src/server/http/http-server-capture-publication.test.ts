import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { PNG } from '@agent-device/capture-kit/png';
import { screenRecordingResourceStore } from '@agent-device/capture-kit/screen-recording-resource-store';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { createRequestHandler } from '../../__tests__/support/test-device-runtime-gateway.ts';
import { makeAndroidSession } from '../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { screenshotRuntimeFixture } from '../../__tests__/support/screenshot-runtime-fixture.ts';
import { screenshotCommandSurface } from '../../__tests__/support/screenshot-command-surface-fake.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import { trackDownloadableArtifact } from '../../resources/artifact-tracking.ts';
import { finalizeDaemonResponse } from '../request-finalization.ts';
import { makeRecordRuntimeHarness } from '../../sessions/handlers/__tests__/record-runtime.fixtures.ts';
import { successfulData, withHttp } from './http-output.fixtures.ts';

test('downloadable screenshots keep the published frame when the caller output is reused', async () => {
  const root = mkdtempForTestSync('immutable-screenshot-');
  const destination = path.join(root, 'capture.png');
  const sessionStore = makeSessionStore('immutable-screenshot-session-');
  sessionStore.publish('capture', makeAndroidSession('capture'));
  const png = (red: number) => {
    const frame = new PNG({ width: 1, height: 1 });
    frame.data.set([red, 0, 0, 255]);
    return PNG.sync.write(frame);
  };
  const original = png(42);
  const replacement = png(84);
  const frames = [original, replacement];
  const runtime = screenshotRuntimeFixture({
    onCapture: ({ outPath }) => {
      fs.writeFileSync(outPath, frames.shift()!);
    },
  });
  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: screenshotCommandSurface,
    logPath: path.join(root, 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    deviceRuntimeGateway: runtime.gateway,
    trackDownloadableArtifact,
  });
  await withHttp(handler, async (post, base) => {
    const capture = { command: 'screenshot', session: 'capture', positionals: [destination] };
    const first = successfulData(
      await post(
        {
          ...capture,
          meta: { clientArtifactPaths: { path: '/client/first.png' } },
        },
        false,
      ),
    );
    const second = successfulData(await post(capture, false));
    expect(second.path).toBe(destination);
    const artifactId = first.artifacts?.[0]?.artifactId;
    expect(artifactId).toBeTypeOf('string');
    const download = await fetch(`${base}/artifacts/${artifactId}`, {
      headers: { authorization: 'Bearer test-token' },
    });
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(original);
    expect(fs.readFileSync(destination)).toEqual(replacement);
  });
});

test('direct HTTP recording replay requires known remote output provenance', async () => {
  const harness = makeRecordRuntimeHarness('legacy-remote-recording-');
  const start = harness.runtime.start.getMockImplementation()!;
  harness.runtime.start.mockImplementation(async (input) => {
    fs.writeFileSync(input.outputPath, 'recorded-video');
    return await start(input);
  });
  const started = await harness.run(['start'], {
    clientArtifactPaths: { outPath: '/client/recording.mp4' },
  });
  expect(started.ok).toBe(true);
  expect((await harness.run(['stop'])).ok).toBe(true);
  const resourcePath = screenRecordingResourceStore.resolvePath(
    harness.sessionStore.resolveSessionDir(harness.sessionName),
  );
  const record = screenRecordingResourceStore.read(resourcePath);
  if (record.status !== 'decoded') throw new Error('Expected completed recording');
  const { remoteCaptureLease: _owner, ...metadata } = record.envelope.metadata ?? {};
  screenRecordingResourceStore.write(resourcePath, { ...record.envelope, metadata });
  await withHttp(
    async (request) =>
      finalizeDaemonResponse(
        request,
        await harness.run(request.positionals, request.meta, request.flags, request.internal),
        trackDownloadableArtifact,
      ),
    async (post, base) => {
      const replay = async () => await post({ command: 'record', positionals: ['stop'] }, false);
      expect((await replay()).error?.data?.details).toMatchObject({
        reason: 'LEASE_OUTPUT_MISMATCH',
      });
      screenRecordingResourceStore.write(resourcePath, {
        ...record.envelope,
        metadata: { ...metadata, remoteCaptureLease: 'unleased' },
      });
      const data = successfulData(await replay());
      const id = data.artifacts?.[0]?.artifactId;
      const download = await fetch(`${base}/artifacts/${id}`, {
        headers: { authorization: 'Bearer test-token' },
      });
      expect(download.status).toBe(200);
      expect(await download.text()).toBe('recorded-video');
    },
  );
});

test('record stop keeps the unleased producer when the stop runs under a lease', async () => {
  const harness = makeRecordRuntimeHarness('remote-recording-later-lease-');
  const start = harness.runtime.start.getMockImplementation()!;
  harness.runtime.start.mockImplementation(async (input) => {
    fs.writeFileSync(input.outputPath, 'unleased-video');
    return await start(input);
  });
  const lease = new LeaseRegistry().allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-a',
    leaseBackend: 'android-instance',
  });
  await withHttp(
    async (request) => {
      const admitted =
        request.positionals?.[0] === 'stop'
          ? { ...request, internal: { ...request.internal, admittedLease: lease } }
          : request;
      return finalizeDaemonResponse(
        admitted,
        await harness.run(admitted.positionals, admitted.meta, admitted.flags, admitted.internal),
        trackDownloadableArtifact,
      );
    },
    async (post, base) => {
      successfulData(await post({ command: 'record', positionals: ['start'] }));
      harness.sessionStore.update(harness.sessionStore.lookup(harness.sessionName)!, {
        lease: { leaseId: lease.leaseId, tenantId: lease.tenantId, runId: lease.runId },
      });
      const output = successfulData(await post({ command: 'record', positionals: ['stop'] }));
      const id = output.artifacts?.[0]?.artifactId;
      expect(id).toBeTypeOf('string');
      const download = await fetch(`${base}/artifacts/${id}`, {
        headers: { authorization: 'Bearer test-token' },
      });
      expect(download.status).toBe(200);
      expect(await download.text()).toBe('unleased-video');
    },
  );
});
