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
import { sessionLeaseOf } from '../../core/lease-context.ts';
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
  const clientPath = '/client/recording';
  const started = await harness.run(['start', placeholder], {
    clientArtifactPaths: { outPath: clientPath },
  });
  expect(started.ok).toBe(true);
  const capture = harness.runtime.start.mock.calls[0]![0];
  expect(capture.clientOutputPath).toBe(clientPath);
  const capturePath = capture.outputPath;
  expect(path.extname(capturePath)).toBe('.mp4');
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
      expect(data.artifacts?.[0]?.localPath).toBe(clientPath);
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
        lease: sessionLeaseOf(lease),
      });
      const output = successfulData(
        await post({
          command: 'record',
          positionals: ['stop'],
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

test.each(['leased at start', 'leased after start'])(
  'a downloadable trace preserves producer ownership when the session is %s',
  async (scenario) => {
    const sessionStore = makeSessionStore('leased-trace-session-');
    sessionStore.publish('capture', makeAndroidSession('capture'));
    const leaseRegistry = new LeaseRegistry();
    const scope = { tenantId: 'tenant', runId: 'trace', leaseBackend: 'android-instance' } as const;
    const lease = leaseRegistry.allocateLease(scope);
    const { leaseId } = lease;
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
      const leasedAtStart = scenario === 'leased at start';
      const unleased = { tenantId: scope.tenantId };
      successfulData(await trace('start', leasedAtStart ? owner : unleased));
      const script = 'flow.ad';
      successfulData(
        await post({
          command: 'replay',
          session: 'capture',
          positionals: [script],
          flags: {
            replayKeepSession: true,
            replayScriptSource: {
              entry: script,
              files: { [script]: 'context platform=android\nwait 0\n' },
            },
          },
          meta: { ...(leasedAtStart ? owner : unleased), sessionExplicit: true },
        }),
      );
      const wait = (requestId: string, meta = {}) =>
        post({
          command: 'wait',
          session: 'capture',
          positionals: ['1'],
          meta: { ...meta, requestId },
        });
      if (leasedAtStart) {
        successfulData(await wait('trace-other-request', unleased));
        successfulData(await wait('trace-owner-request', owner));
        expect((await trace('stop', unleased)).error?.data?.details).toMatchObject({
          reason: 'LEASE_OUTPUT_MISMATCH',
        });
      } else {
        successfulData(await wait('trace-owner-request', unleased));
        sessionStore.update(sessionStore.lookup('capture')!, {
          lease: sessionLeaseOf(lease),
        });
        successfulData(await wait('trace-other-request', owner));
      }
      const id = successfulData(await trace('stop', owner)).artifacts?.[0]?.artifactId;
      const url = `${base}/artifacts/${id}`;
      const headers = {
        authorization: 'Bearer test-token',
        [DAEMON_HTTP_TENANT_HEADER]: scope.tenantId,
      };
      if (leasedAtStart) expect((await fetch(url, { headers })).status).toBe(401);
      const served = await fetch(url, {
        headers: leasedAtStart ? { ...headers, [DAEMON_HTTP_LEASE_HEADER]: leaseId } : headers,
      });
      expect(served.status).toBe(200);
      const log = await served.text();
      const events = log
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'replay_action_start' }),
          expect.objectContaining({ type: 'replay_action_stop' }),
        ]),
      );
      expect(log).toContain('trace-owner-request');
      expect(log).not.toContain('trace-other-request');
    });
  },
);
