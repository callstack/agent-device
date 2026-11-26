import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  closeLoopbackServer,
  createTestHostEnvironment,
  createUnavailableRuntimeFactsForTest,
  listenOnLoopback,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { DAEMON_HTTP_LEASE_HEADER } from '@agent-device/contracts/daemon-http';
import { deriveRecordingTelemetryPath } from '@agent-device/capture-kit/recording-telemetry';
import { clearRequestCanceled, markRequestCanceled } from '@agent-device/host-kit/request';
import { defineUse } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createDaemonHttpServer } from './http-server.ts';
import { createRequestHandler } from '../../__tests__/support/test-device-runtime-gateway.ts';
import { screenshotCommandSurface } from '../../__tests__/support/screenshot-command-surface-fake.ts';
import { makeRecordRuntimeHarness } from '../../sessions/handlers/__tests__/record-runtime.fixtures.ts';
import { tenantScopedSessionName } from '../../core/session-tenant-scope.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import {
  listDownloadableArtifacts,
  cleanupDownloadableArtifact,
} from '../../resources/artifact-tracking.ts';

test.each([
  { clientDestination: false, cancelStop: false },
  { clientDestination: true, cancelStop: false },
  { clientDestination: true, cancelStop: true },
])(
  'local stop keeps the producing tenant for a remote recording ($clientDestination, stop canceled: $cancelStop)',
  async ({ clientDestination, cancelStop }) => {
    const root = mkdtempForTestSync('capture-producing-tenant-');
    const tenantId = 'tenant-a';
    const sessionName = tenantScopedSessionName(tenantId, 'capture');
    const leaseRegistry = new LeaseRegistry();
    const lease = leaseRegistry.allocateLease({ tenantId, runId: 'capture-run' });
    const harness = makeRecordRuntimeHarness('capture-producing-session-', {
      sessionName,
      appBundleId: 'com.example.app',
      sessionScope: { kind: 'tenant', id: tenantId },
      lease: { backend: lease.backend, tenantId, runId: lease.runId, leaseId: lease.leaseId },
    });
    const start = harness.runtime.start.getMockImplementation()!;
    harness.runtime.start.mockImplementation(async (input) => {
      fs.writeFileSync(input.outputPath, 'private-recording');
      return await start(input);
    });
    const finish = harness.runtime.finish.getMockImplementation()!;
    const canceledStopId = 'recording-response-canceled';
    let cancelNextFinish = cancelStop;
    harness.runtime.finish.mockImplementation(async () => {
      const stopped = await finish();
      if (cancelNextFinish) {
        cancelNextFinish = false;
        markRequestCanceled(canceledStopId);
      }
      const { result } = stopped;
      const chunk = result.outPath.replace(/\.mp4$/, '.part-002.mp4');
      const telemetryPath = deriveRecordingTelemetryPath(result.outPath);
      fs.writeFileSync(chunk, 'second-chunk');
      fs.writeFileSync(telemetryPath, '{"events":[]}');
      return {
        ...stopped,
        result: {
          ...result,
          telemetryPath,
          chunks: [
            { index: 1, path: result.outPath },
            { index: 2, path: chunk },
          ],
        },
      };
    });
    const recordingUse = defineUse({
      required: ['screenRecordingStart', 'screenRecordingReattach', 'screenRecordingCleanup'],
    });
    const recordingBinding = async (device: DeviceInfo) => {
      const runtime = await harness.runtime.bindDevice(device, recordingUse);
      const facts = createUnavailableRuntimeFactsForTest(device, runtime.owner);
      return {
        device,
        owner: runtime.owner,
        facts: { ...facts, operations: { ...facts.operations, ...runtime.facts } },
        operations: runtime.operations,
        [Symbol.asyncDispose]: async () => {},
      };
    };
    const handleRequest = createRequestHandler({
      host: createTestHostEnvironment({ cwd: root, env: {} }),
      createCommandSurface: screenshotCommandSurface,
      logPath: path.join(root, 'daemon.log'),
      token: 'capture-token',
      sessionStore: harness.sessionStore,
      leaseRegistry,
      deviceInventoryGateways: createTestDeviceInventoryGateways(),
      deviceRuntimeGateway: {
        inspectFacts: async (device) => (await recordingBinding(device)).facts,
        bind: async ({ device }) => await recordingBinding(device),
        shutdown: async () => {},
      },
      trackDownloadableArtifact: () => {
        throw new Error('Recording must be committed before request finalization');
      },
    });
    const hookPath = path.join(root, 'auth-hook.mjs');
    fs.writeFileSync(
      hookPath,
      'export default ({ headers }) => ({ tenantId: headers["x-tenant"] ?? "tenant-a" });',
    );
    const server = await createDaemonHttpServer({
      token: 'capture-token',
      handleRequest,
      env: { AGENT_DEVICE_HTTP_AUTH_HOOK: hookPath },
      cwd: root,
    });
    try {
      const base = `http://127.0.0.1:${await listenOnLoopback(server)}`;
      const started = await fetch(`${base}/rpc`, {
        method: 'POST',
        headers: { authorization: 'Bearer capture-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'capture',
          method: 'agent_device.command',
          params: {
            command: 'record',
            session: 'capture',
            positionals: ['start'],
            meta: {
              runId: lease.runId,
              leaseId: lease.leaseId,
              ...(clientDestination
                ? { clientArtifactPaths: { outPath: '/client/video.mp4' } }
                : {}),
            },
          },
        }),
      });
      const startBody = await started.json();
      expect(startBody.result?.ok, JSON.stringify(startBody)).toBe(true);

      const stop = async (requestId?: string) =>
        await handleRequest({
          token: 'capture-token',
          session: sessionName,
          command: 'record',
          positionals: ['stop'],
          meta: { leaseId: lease.leaseId, requestId },
        });
      if (cancelStop) {
        expect(await stop(canceledStopId)).toMatchObject({
          ok: false,
          error: { details: { reason: 'request_canceled' } },
        });
        const owner = { tenantId, leaseId: lease.leaseId };
        const retained = await listDownloadableArtifacts(owner, {});
        expect(retained.map((entry) => entry.artifactType)).toEqual([
          'screen-recording',
          'screen-recording-chunk',
          'screen-recording-telemetry',
        ]);
        expect(await listDownloadableArtifacts({ tenantId }, {})).toEqual([]);
        expect(await listDownloadableArtifacts({ tenantId, leaseId: 'f'.repeat(32) }, {})).toEqual(
          [],
        );
        expect(await listDownloadableArtifacts({ ...owner, tenantId: 'tenant-b' }, {})).toEqual([]);
      }
      const stopped = await stop();
      expect(stopped.ok, JSON.stringify(stopped)).toBe(true);
      if (!stopped.ok) return;
      const artifactId = stopped.data?.artifacts?.[0]?.artifactId;
      expect(artifactId).toBeTypeOf('string');
      expect(stopped.data?.artifacts?.map(({ field, path }) => [field, path])).toEqual([
        ['outPath', undefined],
        ['chunkPath', undefined],
        ['telemetryPath', undefined],
      ]);
      expect(await listDownloadableArtifacts({ tenantId: 'tenant-b' }, {})).toEqual([]);
      expect(
        (await listDownloadableArtifacts({ tenantId, leaseId: lease.leaseId }, {})).some(
          ({ id }) => id === artifactId,
        ),
      ).toBe(true);
      expect(await listDownloadableArtifacts({ tenantId }, {})).toEqual([]);

      const recovered = await stop();
      expect(recovered.ok, JSON.stringify(recovered)).toBe(true);
      if (recovered.ok) expect(recovered.data?.artifacts?.[0]?.artifactId).toBe(artifactId);

      const otherTenant = await fetch(`${base}/artifacts/${artifactId}`, {
        headers: { authorization: 'Bearer capture-token', 'x-tenant': 'tenant-b' },
      });
      expect(otherTenant.status).toBe(401);
      for (const leaseId of [undefined, 'f'.repeat(32)]) {
        const denied = await fetch(`${base}/artifacts/${artifactId}`, {
          headers: {
            authorization: 'Bearer capture-token',
            ...(leaseId ? { [DAEMON_HTTP_LEASE_HEADER]: leaseId } : {}),
          },
        });
        expect(denied.status).toBe(401);
        expect(await denied.json()).toMatchObject({ reason: 'LEASE_OUTPUT_MISMATCH' });
      }
      const ownTenant = await fetch(`${base}/artifacts/${artifactId}`, {
        headers: {
          authorization: 'Bearer capture-token',
          'x-tenant': tenantId,
          [DAEMON_HTTP_LEASE_HEADER]: lease.leaseId,
        },
      });
      expect(ownTenant.status).toBe(200);
      expect(await ownTenant.text()).toBe('private-recording');
      const sourcePath = harness.runtime.start.mock.calls[0]![0].outputPath;
      // A consumed export cannot be re-minted from a replacement written at that path.
      await expect.poll(() => fs.existsSync(sourcePath)).toBe(false);
      expect(await stop()).toMatchObject({
        ok: false,
        error: { code: 'COMMAND_FAILED', details: { reason: 'RESOURCE_EXPIRED' } },
      });
      fs.writeFileSync(sourcePath, 'unrelated-replacement');
      expect(await stop()).toMatchObject({ ok: false });
      expect(fs.readFileSync(sourcePath, 'utf8')).toBe('unrelated-replacement');
      for (const [index, bytes] of [
        [1, 'second-chunk'],
        [2, '{"events":[]}'],
      ] as const) {
        const sidecar = await fetch(
          `${base}/artifacts/${stopped.data?.artifacts?.[index]?.artifactId}`,
          {
            headers: {
              authorization: 'Bearer capture-token',
              [DAEMON_HTTP_LEASE_HEADER]: lease.leaseId,
            },
          },
        );
        expect(sidecar.status).toBe(200);
        expect(await sidecar.text()).toBe(bytes);
      }
      for (const { id } of await listDownloadableArtifacts(
        { tenantId, leaseId: lease.leaseId },
        {},
      )) {
        cleanupDownloadableArtifact(id);
      }
    } finally {
      clearRequestCanceled(canceledStopId);
      await closeLoopbackServer(server);
    }
  },
);
