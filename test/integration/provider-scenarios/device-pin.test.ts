import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { createAgentDeviceClient } from '@agent-device/client';
import { runCommand } from '@agent-device/command-surface';
import type { DevicePin } from '@agent-device/contracts/device';
import {
  FIRST_SCREEN_NODES,
  PROVIDER_SCENARIO_ANDROID,
  PROVIDER_SCENARIO_IOS_SIMULATOR,
  PROVIDER_SCENARIO_MACOS,
} from './fixtures.ts';
import { assertRpcError, assertRpcOk } from './assertions.ts';
import { createProviderScenarioHarness, withProviderScenarioResource } from './harness.ts';
import {
  createAppleRunnerProviderFromTranscript,
  createRecordingAppleToolProvider,
  simctlDeviceLifecycleHandler,
} from './providers.ts';
import { createProviderTranscript } from './transcript.ts';

test('Provider-backed integration admits an existing session device through its current pin before capture', async () => {
  const device = PROVIDER_SCENARIO_IOS_SIMULATOR;
  const other = { ...device, id: 'sim-other', name: 'Other iPhone' };
  const transcript = createProviderTranscript([
    {
      command: 'ios.runner.snapshot',
      platform: 'apple',
      deviceId: device.id,
      repeat: true,
      result: {
        // A populated first screen, so the first capture after open settles on one quiet pair.
        nodes: [
          { ...FIRST_SCREEN_NODES[0], label: 'Existing Session App' },
          ...FIRST_SCREEN_NODES.slice(1),
        ],
        truncated: false,
      },
    },
  ]);
  const runner = createAppleRunnerProviderFromTranscript(transcript, 'ios.runner');
  const appleTool = createRecordingAppleToolProvider({
    simctl: simctlDeviceLifecycleHandler('com.apple.CoreSimulator.SimRuntime.iOS-18-0', [
      { name: device.name, udid: device.id },
      { name: other.name, udid: other.id },
    ]),
  });
  await withProviderScenarioResource(
    () =>
      createProviderScenarioHarness({
        deviceInventoryProvider: async () => [device, other],
        appleRunnerProvider: () => runner,
        appleToolProvider: () => appleTool.provider,
      }),
    async (daemon) => {
      const session = 'pin-existing';
      assertRpcOk(
        await daemon.callCommand(
          'open',
          ['com.example.app'],
          { platform: 'ios', udid: device.id },
          { session },
        ),
      );
      assert.equal(await daemon.hasSession(session), true);
      const pin: DevicePin = {
        selector: { platform: 'ios', udid: other.id },
        source: { kind: 'project', path: '/project/agent-device.json' },
      };
      const refused = await daemon.callCommand(
        'snapshot',
        [],
        {},
        { session, meta: { devicePin: pin } },
      );
      expect(assertRpcError(refused, 400, 'INVALID_ARGS', /device pin/).details).toMatchObject({
        reason: 'device_pin_conflict',
        pinSource: 'project config file /project/agent-device.json',
        device: { id: device.id, name: device.name },
      });
      assert.equal(transcript.calls.length, 0);
      const accepted = await daemon.callCommand(
        'snapshot',
        [],
        {},
        {
          session,
          meta: { devicePin: { ...pin, selector: { platform: 'ios', udid: device.id } } },
        },
      );
      expect(assertRpcOk(accepted).nodes).toContainEqual(
        expect.objectContaining({ label: 'Existing Session App' }),
      );
      assert.ok(transcript.calls.length > 0);
      assert.ok(transcript.calls.every((call) => call.deviceId === device.id));
      transcript.assertComplete();
    },
  );
});

for (const platform of ['ios', 'android'] as const) {
  test(`Provider-backed integration ${platform} pin validates the selected device through HTTP`, async () => {
    const pinned = {
      ...(platform === 'ios' ? PROVIDER_SCENARIO_IOS_SIMULATOR : PROVIDER_SCENARIO_ANDROID),
      id: `${platform}-pinned`,
      name: 'Project Device',
    };
    const other = { ...pinned, id: `${platform}-other`, name: 'Other Device' };
    const pin: DevicePin = {
      selector: { platform, device: pinned.name },
      source: { kind: 'project', path: '/project/agent-device.json' },
    };
    await withProviderScenarioResource(
      () => createProviderScenarioHarness({ deviceInventoryProvider: async () => [pinned, other] }),
      async (daemon) => {
        const incompatibleIdentity =
          platform === 'ios' ? { serial: 'ANDROID-001' } : { udid: 'IPAD-001' };
        const incompatible = await daemon.callCommand('capabilities', [], incompatibleIdentity, {
          meta: { devicePin: pin },
        });
        const refusal = assertRpcError(incompatible, 400, 'INVALID_ARGS', /device pin/);
        expect(refusal.details).toMatchObject({
          reason: 'device_pin_conflict',
          pinSource: 'project config file /project/agent-device.json',
        });
        const client = createAgentDeviceClient(
          {
            daemonBaseUrl: daemon.baseUrl,
            daemonAuthToken: daemon.token,
          },
          { devicePin: pin },
        );
        const identity = platform === 'ios' ? 'udid' : 'serial';
        const result = await runCommand(client, 'capabilities', {
          [identity]: pinned.id,
          device: 'project_device',
        });
        assert.equal(result.device?.id, pinned.id);
        await assert.rejects(
          runCommand(client, 'capabilities', { [identity]: other.id }),
          (error: unknown) => {
            assert.ok(error instanceof Error && 'details' in error);
            expect(error.details).toMatchObject({
              reason: 'device_pin_conflict',
              pin: pin.selector,
              pinSource: 'project config file /project/agent-device.json',
              conflicts: [],
              device: { id: other.id, name: other.name },
            });
            return true;
          },
        );
        const identityPin = createAgentDeviceClient(
          { daemonBaseUrl: daemon.baseUrl, daemonAuthToken: daemon.token },
          { devicePin: { ...pin, selector: { platform, [identity]: pinned.id } } },
        );
        await assert.rejects(
          runCommand(identityPin, 'capabilities', { device: other.name }),
          (error: unknown) => {
            assert.ok(error instanceof Error && 'details' in error);
            expect(error.details).toMatchObject({ reason: 'device_pin_conflict' });
            return true;
          },
        );
        const batch = await daemon.callCommand(
          'batch',
          [],
          {
            batchSteps: [
              {
                command: 'capabilities',
                flags: { platform: platform === 'ios' ? 'android' : 'ios' },
              },
            ],
          },
          { meta: { devicePin: pin } },
        );
        const error = assertRpcError(batch, 400, 'INVALID_ARGS', /Batch step 1/);
        assert.equal((error.details as { reason: string }).reason, 'device_pin_conflict');
      },
    );
  });
}

for (const [pinnedPlatform, requestedPlatform, expectedId] of [
  ['ios', 'apple', PROVIDER_SCENARIO_IOS_SIMULATOR.id],
  ['macos', 'apple', PROVIDER_SCENARIO_MACOS.id],
  ['apple', 'ios', PROVIDER_SCENARIO_IOS_SIMULATOR.id],
  ['apple', 'macos', PROVIDER_SCENARIO_MACOS.id],
] as const) {
  test(`Provider-backed integration ${pinnedPlatform} pin intersects ${requestedPlatform} before selection`, async () => {
    const pin: DevicePin = {
      selector: { platform: pinnedPlatform },
      source: { kind: 'project', path: '/project/agent-device.json' },
    };
    await withProviderScenarioResource(
      () =>
        createProviderScenarioHarness({
          deviceInventoryProvider: async () => [
            PROVIDER_SCENARIO_MACOS,
            PROVIDER_SCENARIO_IOS_SIMULATOR,
          ],
        }),
      async (daemon) => {
        const flags = { platform: requestedPlatform };
        const direct = await daemon.callCommand('capabilities', [], flags, {
          meta: { devicePin: pin },
        });
        expect(assertRpcOk(direct)).toMatchObject({ device: { id: expectedId } });
        const client = createAgentDeviceClient(
          { daemonBaseUrl: daemon.baseUrl, daemonAuthToken: daemon.token },
          { devicePin: pin },
        );
        const result = await runCommand(client, 'capabilities', flags);
        assert.equal(result.device?.id, expectedId);
        const batch = await daemon.callCommand(
          'batch',
          [],
          { batchSteps: [{ command: 'capabilities', flags }] },
          { meta: { devicePin: pin } },
        );
        expect(assertRpcOk(batch)).toMatchObject({
          results: [{ data: { device: { id: expectedId } } }],
        });
      },
    );
  });
}

test('Provider-backed integration proxy allocation narrows a platform pin before binding its key', async () => {
  await withProviderScenarioResource(
    () =>
      createProviderScenarioHarness({
        deviceInventoryProvider: async () => [
          PROVIDER_SCENARIO_MACOS,
          PROVIDER_SCENARIO_IOS_SIMULATOR,
        ],
      }),
    async (daemon) => {
      const result = await daemon.callCommand(
        'lease_allocate',
        [],
        { platform: 'apple' },
        {
          meta: {
            tenantId: 'team-a',
            runId: 'run-a',
            clientId: 'client-a',
            leaseProvider: 'proxy',
            leaseBackend: 'ios-instance',
            devicePin: {
              selector: { platform: 'ios' },
              source: { kind: 'project', path: '/project/agent-device.json' },
            },
          },
        },
      );
      expect(assertRpcOk(result)).toMatchObject({
        lease: { deviceKey: 'ios:mobile:sim-1' },
      });
    },
  );
});

test('Provider-backed integration proxy keys and lease retries are admitted through the wire pin', async () => {
  const pin: DevicePin = {
    selector: { platform: 'ios', udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id },
    source: { kind: 'project', path: '/project/agent-device.json' },
  };
  const other = { ...PROVIDER_SCENARIO_IOS_SIMULATOR, id: 'sim-other' };
  await withProviderScenarioResource(
    () =>
      createProviderScenarioHarness({
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_IOS_SIMULATOR, other],
      }),
    async (daemon) => {
      const allocate = (meta: NonNullable<Parameters<typeof daemon.callCommand>[3]>['meta']) =>
        daemon.callCommand(
          'lease_allocate',
          [],
          {},
          {
            meta: {
              tenantId: 'pin-key-team',
              runId: 'pin-key-run',
              clientId: 'pin-key-client',
              leaseProvider: 'proxy',
              leaseBackend: 'ios-instance',
              ...meta,
            },
          },
        );
      const refused = await allocate({
        leaseProvider: ' proxy ',
        deviceKey: 'ios:mobile:sim-other',
        devicePin: pin,
      });
      expect(
        assertRpcError(refused, 400, 'INVALID_ARGS', /pinned device|device pin/).details,
      ).toMatchObject({
        reason: 'device_pin_conflict',
        pinSource: 'project config file /project/agent-device.json',
      });
      const original = assertRpcOk<{ lease: { leaseId: string } }>(
        await allocate({ deviceKey: 'ios:mobile:sim-other' }),
      );
      const retry = await allocate({ leaseId: original.lease.leaseId, devicePin: pin });
      expect(
        assertRpcError(retry, 400, 'INVALID_ARGS', /pinned device|device pin/).details,
      ).toMatchObject({
        reason: 'device_pin_conflict',
      });
      const matching = assertRpcOk<{ lease: { leaseId: string; deviceKey: string } }>(
        await allocate({ deviceKey: 'ios:mobile:sim-1', devicePin: pin }),
      );
      assert.equal(matching.lease.deviceKey, 'ios:mobile:sim-1');
      expect(
        assertRpcOk(await allocate({ leaseId: matching.lease.leaseId, devicePin: pin })),
      ).toMatchObject({
        lease: { leaseId: matching.lease.leaseId, deviceKey: matching.lease.deviceKey },
        reused: true,
      });
    },
  );
});

for (const command of ['capabilities', 'lease_allocate'] as const) {
  test(`Provider-backed integration ${command} rejects malformed raw wire pins before selection`, async () => {
    let inventoryReads = 0;
    await withProviderScenarioResource(
      () =>
        createProviderScenarioHarness({
          deviceInventoryProvider: async () => {
            inventoryReads += 1;
            return [PROVIDER_SCENARIO_IOS_SIMULATOR];
          },
        }),
      async (daemon) => {
        const source = { kind: 'project', path: '/project/agent-device.json' };
        const configSource = 'project config file /project/agent-device.json';
        const requestSource = 'daemon request metadata';
        for (const [devicePin, pinSource] of [
          [{}, requestSource],
          [null, requestSource],
          [false, requestSource],
          [{ selector: { platform: 'ios' } }, requestSource],
          [{ selector: {}, source }, configSource],
          [{ selector: { platform: 'windows' }, source }, configSource],
          [{ selector: { platform: 'ios', serial: 'emulator-5554' }, source }, configSource],
          [{ selector: { platform: 'android', udid: 'SIM-1' }, source }, configSource],
          [{ selector: { udid: 'SIM-1', serial: 'emulator-5554' }, source }, configSource],
          [{ selector: { udid: 4 }, source }, configSource],
          [
            { selector: { platform: 'ios' }, source: { ...source, kind: 'environment' } },
            requestSource,
          ],
          [{ selector: { platform: 'ios' }, source: { ...source, path: '' } }, requestSource],
        ] as const) {
          const allocation = command === 'lease_allocate';
          const response = await fetch(`${daemon.baseUrl}/rpc`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${daemon.token}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 'invalid-pin',
              method: allocation ? 'agent_device.lease.allocate' : 'agent_device.command',
              params: allocation
                ? {
                    tenantId: 'pin-test',
                    runId: 'pin-test',
                    leaseProvider: 'proxy',
                    backend: 'ios-instance',
                    clientId: 'pin-test',
                    platform: 'ios',
                    devicePin,
                  }
                : { command, positionals: [], meta: { devicePin } },
            }),
          });
          const error = assertRpcError(
            { statusCode: response.status, json: await response.json() },
            400,
            'INVALID_ARGS',
            /devicePin/,
          );
          expect(error.details).toMatchObject({ reason: 'invalid_device_pin', pinSource });
        }
        assert.equal(inventoryReads, 0);
      },
    );
  });
}
