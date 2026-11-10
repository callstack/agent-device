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
  trackDownloadableArtifact,
} from '../../resources/artifact-tracking.ts';

test.each([false, true])(
  'local stop keeps the producing tenant for a remote recording (client destination: %s)',
  async (clientDestination) => {
    const root = mkdtempForTestSync('capture-producing-tenant-');
    const tenantId = 'tenant-a';
    const sessionName = tenantScopedSessionName(tenantId, 'capture');
    const harness = makeRecordRuntimeHarness('capture-producing-session-', {
      sessionName,
      appBundleId: 'com.example.app',
    });
    const leaseRegistry = new LeaseRegistry();
    const lease = leaseRegistry.allocateLease({ tenantId, runId: 'capture-run' });
    harness.sessionStore.update(harness.sessionStore.lookup(sessionName)!, {
      sessionScope: { kind: 'tenant', id: tenantId },
      lease: { tenantId, runId: lease.runId, leaseId: lease.leaseId },
    });
    const start = harness.runtime.start.getMockImplementation()!;
    harness.runtime.start.mockImplementation(async (input) => {
      fs.writeFileSync(input.outputPath, 'private-recording');
      return await start(input);
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
      trackDownloadableArtifact,
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

      const stop = async () =>
        await handleRequest({
          token: 'capture-token',
          session: sessionName,
          command: 'record',
          positionals: ['stop'],
        });
      const stopped = await stop();
      expect(stopped.ok, JSON.stringify(stopped)).toBe(true);
      if (!stopped.ok) return;
      const artifactId = stopped.data?.artifacts?.[0]?.artifactId;
      expect(artifactId).toBeTypeOf('string');
      expect(await listDownloadableArtifacts('tenant-b', {})).toEqual([]);
      expect(
        (await listDownloadableArtifacts(tenantId, {})).some(({ id }) => id === artifactId),
      ).toBe(true);

      const recovered = await stop();
      expect(recovered.ok, JSON.stringify(recovered)).toBe(true);
      if (recovered.ok) expect(recovered.data?.artifacts?.[0]?.artifactId).toBe(artifactId);

      const otherTenant = await fetch(`${base}/artifacts/${artifactId}`, {
        headers: { authorization: 'Bearer capture-token', 'x-tenant': 'tenant-b' },
      });
      expect(otherTenant.status).toBe(401);
      const ownTenant = await fetch(`${base}/artifacts/${artifactId}`, {
        headers: { authorization: 'Bearer capture-token', 'x-tenant': tenantId },
      });
      expect(ownTenant.status).toBe(200);
      expect(await ownTenant.text()).toBe('private-recording');
    } finally {
      await closeLoopbackServer(server);
    }
  },
);
