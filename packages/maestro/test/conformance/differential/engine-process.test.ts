import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyAgentDeviceFailure } from './engine-process.ts';

test('agent-device JSON distinguishes infrastructure from behavioral failures', () => {
  const result = (infrastructure?: true) =>
    JSON.stringify({
      success: true,
      data: {
        failures: [
          {
            status: 'failed',
            ...(infrastructure ? { infrastructure } : {}),
          },
        ],
      },
    });

  assert.equal(classifyAgentDeviceFailure(result(true)), 'infrastructure');
  assert.equal(classifyAgentDeviceFailure(result()), 'behavioral');
  assert.equal(classifyAgentDeviceFailure('not-json'), 'infrastructure');
});
