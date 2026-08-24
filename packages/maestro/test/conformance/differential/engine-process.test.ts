import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { classifyAgentDeviceFailure, runAgentDeviceEngine } from './engine-process.ts';

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

test('agent-device execution accepts a CLI path containing spaces', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-engine path-'));
  const cliPath = path.join(root, 'agent device.mjs');
  try {
    fs.writeFileSync(cliPath, '');
    assert.deepEqual(runAgentDeviceEngine(cliPath, []), {
      engine: 'agent-device',
      outcome: 'pass',
      exitCode: 0,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
