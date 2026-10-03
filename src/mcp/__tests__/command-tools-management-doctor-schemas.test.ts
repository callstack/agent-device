import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ownerFilesForCommand } from '@agent-device/command-registry/owner-files';
import { DOCTOR_COMMAND_OUTPUT_SCHEMAS } from '../../commands/management/doctor.ts';
import { COMMAND_OUTPUT_SCHEMAS } from '../command-output-schemas.ts';

const DOCTOR_COMMANDS = Object.keys(DOCTOR_COMMAND_OUTPUT_SCHEMAS) as Array<
  keyof typeof DOCTOR_COMMAND_OUTPUT_SCHEMAS
>;

// doctor does not carry the post-action observation trait (#1652): it is a device-runtime
// command, not an interaction command, so the composed map never copies the entry and
// reference equality must hold.
test('MCP doctor family output schemas are the family module entries, not copies', () => {
  for (const command of DOCTOR_COMMANDS) {
    assert.equal(
      COMMAND_OUTPUT_SCHEMAS[command],
      DOCTOR_COMMAND_OUTPUT_SCHEMAS[command],
      `${command} is not reference-equal to the doctor module's own schema object`,
    );
  }
});

test('the projected family map declares exactly the commands its module owns', () => {
  for (const command of DOCTOR_COMMANDS) {
    assert.ok(
      ownerFilesForCommand(command).includes('src/commands/management/doctor.ts'),
      `${command} projects its output schema from this module but does not name it as its owner`,
    );
  }
});
