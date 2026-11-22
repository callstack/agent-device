import {
  buildRemoteTempArtifactPath,
  DAEMON_HTTP_LEASE_HEADER,
  DAEMON_HTTP_TENANT_HEADER,
} from '@agent-device/contracts/daemon-http';
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

test.each(['caller destination', 'remote placeholder'])(
  'downloadable screenshots keep the published frame with a %s',
  async (destinationKind) => {
    const root = mkdtempForTestSync('immutable-screenshot-');
    const placeholder = destinationKind === 'remote placeholder';
    const destination = placeholder
      ? buildRemoteTempArtifactPath('screenshot', '.png')
      : path.join(root, 'capture.png');
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
      if (!placeholder) {
        const second = successfulData(await post(capture, false));
        expect(second.path).toBe(destination);
      }
      const artifactId = first.artifacts?.[0]?.artifactId;
      expect(artifactId).toBeTypeOf('string');
      const download = await fetch(`${base}/artifacts/${artifactId}`, {
        headers: { authorization: 'Bearer test-token' },
      });
      expect(download.status).toBe(200);
      expect(Buffer.from(await download.arrayBuffer())).toEqual(original);
      if (placeholder) expect(fs.existsSync(destination)).toBe(false);
      else expect(fs.readFileSync(destination)).toEqual(replacement);
    });
  },
);

test('direct HTTP recording replay requires known remote output provenance', async () => {
  const harness = makeRecordRuntimeHarness('legacy-remote-recording-');
  const start = harness.runtime.start.getMockImplementation()!;
  harness.runtime.start.mockImplementation(async (input) => {
    fs.writeFileSync(input.outputPath, 'recorded-video');
    return await start(input);
  });
  const placeholder = buildRemoteTempArtifactPath('recording', '.mp4');
  const started = await harness.run(['start', placeholder], {
    clientArtifactPaths: { outPath: '/client/recording.mp4' },
  });
  expect(started.ok).toBe(true);
  const capturePath = harness.runtime.start.mock.calls[0]![0].outputPath;
  expect(path.dirname(capturePath)).toBe(
    harness.sessionStore.resolveSessionDir(harness.sessionName),
  );
  expect(fs.existsSync(placeholder)).toBe(false);
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
      const savedCompletion = metadata.completion;
      if (
        !savedCompletion ||
        typeof savedCompletion !== 'object' ||
        Array.isArray(savedCompletion)
      ) {
        throw new Error('Expected stored recording completion');
      }
      fs.writeFileSync(placeholder, 'legacy-recording');
      try {
        screenRecordingResourceStore.write(resourcePath, {
          ...record.envelope,
          metadata: {
            ...metadata,
            remoteCaptureLease: 'unleased',
            completion: { ...savedCompletion, outPath: placeholder },
          },
        });
        expect((await replay()).error?.data?.details).toMatchObject({
          reason: 'LEASE_OUTPUT_MISMATCH',
        });
      } finally {
        fs.rmSync(placeholder, { force: true });
      }
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
      const output = successfulData(
        await post({
          command: 'record',
          positionals: ['stop'],
          meta: { tenantId: lease.tenantId },
        }),
      );
      const id = output.artifacts?.[0]?.artifactId;
      expect(id).toBeTypeOf('string');
      const url = `${base}/artifacts/${id}`;
      const other = await fetch(url, {
        headers: { authorization: 'Bearer test-token', [DAEMON_HTTP_TENANT_HEADER]: 'tenant-b' },
      });
      expect(other.status).toBe(401);
      const download = await fetch(url, {
        headers: {
          authorization: 'Bearer test-token',
          [DAEMON_HTTP_TENANT_HEADER]: lease.tenantId,
        },
      });
      expect(download.status).toBe(200);
      expect(await download.text()).toBe('unleased-video');
    },
  );
});

test('a downloadable trace accepts events and stop only from its producing lease', async () => {
  const sessionStore = makeSessionStore('leased-trace-session-');
  sessionStore.publish('capture', makeAndroidSession('capture'));
  const leaseRegistry = new LeaseRegistry();
  const scope = { tenantId: 'tenant', runId: 'trace', leaseBackend: 'android-instance' } as const;
  const { leaseId } = leaseRegistry.allocateLease(scope);
  const owner = { ...scope, leaseId };
  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: screenshotCommandSurface,
    logPath: path.join(sessionStore.resolveDaemonStateDir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact,
  });
  await withHttp(handler, async (post, base) => {
    const trace = (action: string, meta = {}) =>
      post({
        command: 'trace',
        session: 'capture',
        positionals: [action],
        meta,
      });
    successfulData(await trace('start', owner));
    const wait = (requestId: string, meta = {}) =>
      post({
        command: 'wait',
        session: 'capture',
        positionals: ['1'],
        meta: { ...meta, requestId },
      });
    successfulData(await wait('trace-other-request', { tenantId: scope.tenantId }));
    successfulData(await wait('trace-owner-request', owner));
    expect((await trace('stop', { tenantId: scope.tenantId })).error?.data?.details).toMatchObject({
      reason: 'LEASE_OUTPUT_MISMATCH',
    });
    const id = successfulData(await trace('stop', owner)).artifacts?.[0]?.artifactId;
    const url = `${base}/artifacts/${id}`;
    const headers = {
      authorization: 'Bearer test-token',
      [DAEMON_HTTP_TENANT_HEADER]: scope.tenantId,
    };
    expect((await fetch(url, { headers })).status).toBe(401);
    const served = await fetch(url, {
      headers: { ...headers, [DAEMON_HTTP_LEASE_HEADER]: leaseId },
    });
    expect(served.status).toBe(200);
    const log = await served.text();
    expect(log).toContain('trace-owner-request');
    expect(log).not.toContain('trace-other-request');
  });
});
