import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ownerFilesForCommand } from '@agent-device/command-registry/owner-files';
import { DEVICE_MANAGEMENT_COMMAND_OUTPUT_SCHEMAS } from '../../commands/management/device.ts';
import { COMMAND_OUTPUT_SCHEMAS } from '../command-output-schemas.ts';

const DEVICE_MANAGEMENT_COMMANDS = ['boot', 'shutdown'] as const;

test('the family map declares exactly boot and shutdown', () => {
  assert.deepEqual(Object.keys(DEVICE_MANAGEMENT_COMMAND_OUTPUT_SCHEMAS).sort(), [
    ...DEVICE_MANAGEMENT_COMMANDS,
  ]);
});

// Neither boot nor shutdown carries the post-action observation trait (#1652): both are
// device-runtime commands, not interaction commands, so the composed map never copies either
// entry and reference equality must hold for both.
test('MCP device management family output schemas are the family module entries, not copies', () => {
  for (const command of DEVICE_MANAGEMENT_COMMANDS) {
    assert.equal(
      COMMAND_OUTPUT_SCHEMAS[command],
      DEVICE_MANAGEMENT_COMMAND_OUTPUT_SCHEMAS[command],
      `${command} is not reference-equal to the device management module's own schema object`,
    );
  }
});

test('the projected family map declares exactly the commands its module owns', () => {
  for (const command of DEVICE_MANAGEMENT_COMMANDS) {
    assert.ok(
      ownerFilesForCommand(command).includes('src/commands/management/device.ts'),
      `${command} projects its output schema from this module but does not name it as its owner`,
    );
  }
});
