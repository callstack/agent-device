import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createAgentDeviceClient } from '../agent-device-client.ts';
import { createTransport } from './client-transport-fixture.ts';

test.each([undefined, { press: 'bounded-geometry' }, { press: 'unknown' }])(
  'the SDK preserves only recognized daemon target-readiness claims: %j',
  async (targetReadiness) => {
    const setup = createTransport(() => ({
      ok: true,
      data: {
        device: {
          platform: 'android',
          id: 'emulator-5554',
          name: 'Pixel',
          target: 'mobile',
          kind: 'emulator',
          booted: true,
        },
        availableCommands: ['press'],
        targetReadiness,
      },
    }));
    const client = createAgentDeviceClient(setup.config, { transport: setup.transport });
    const result = await client.devices.capabilities();
    assert.deepEqual(
      result.targetReadiness,
      targetReadiness?.press === 'bounded-geometry' ? { press: 'bounded-geometry' } : undefined,
    );
  },
);
