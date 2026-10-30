import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ownerFilesForCommand } from '@agent-device/command-registry/owner-files';
import { COMMAND_OUTPUT_SCHEMAS } from './command-output-schemas.ts';
import { RECORDING_COMMAND_OUTPUT_SCHEMAS } from './recording/output-schemas.ts';

const RECORDING_COMMANDS = Object.keys(RECORDING_COMMAND_OUTPUT_SCHEMAS) as Array<
  keyof typeof RECORDING_COMMAND_OUTPUT_SCHEMAS
>;

// Neither record nor trace carries the post-action observation trait (#1652): both fire-and-report
// a recording or trace lifecycle change, not an interaction, so the composed map never copies
// either entry and reference equality must hold for both.
test('MCP recording family output schemas are the family module entries, not copies', () => {
  for (const command of RECORDING_COMMANDS) {
    assert.equal(
      COMMAND_OUTPUT_SCHEMAS[command],
      RECORDING_COMMAND_OUTPUT_SCHEMAS[command],
      `${command} is not reference-equal to the recording module's own schema object`,
    );
  }
});

test('the projected family map declares exactly the commands its module owns', () => {
  for (const command of RECORDING_COMMANDS) {
    assert.ok(
      ownerFilesForCommand(command).includes(
        'packages/command-surface/src/recording/output-schemas.ts',
      ),
      `${command} projects its output schema from this module but does not name it as its owner`,
    );
  }
});
