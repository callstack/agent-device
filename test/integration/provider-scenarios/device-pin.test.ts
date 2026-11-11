import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { createAgentDeviceClient } from '@agent-device/client';
import { runCommand } from '@agent-device/command-surface';
import type { DevicePin } from '@agent-device/contracts/device';
import { PROVIDER_SCENARIO_ANDROID, PROVIDER_SCENARIO_IOS_SIMULATOR } from './fixtures.ts';
import { assertRpcError } from './assertions.ts';
import { createProviderScenarioHarness, withProviderScenarioResource } from './harness.ts';

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
