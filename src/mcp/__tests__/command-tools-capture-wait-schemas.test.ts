import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ownerFilesForCommand } from '@agent-device/command-registry/owner-files';
import { WAIT_COMMAND_OUTPUT_SCHEMAS } from '../../commands/capture/wait.ts';
import { COMMAND_OUTPUT_SCHEMAS } from '../command-output-schemas.ts';

const WAIT_COMMANDS = Object.keys(WAIT_COMMAND_OUTPUT_SCHEMAS) as Array<
  keyof typeof WAIT_COMMAND_OUTPUT_SCHEMAS
>;

// wait does not carry the post-action observation trait (#1652): its descriptor declares no
// post-action observation, so the composed map never copies the entry and reference equality
// must hold.
test('MCP wait family output schemas are the family module entries, not copies', () => {
  for (const command of WAIT_COMMANDS) {
    assert.equal(
      COMMAND_OUTPUT_SCHEMAS[command],
      WAIT_COMMAND_OUTPUT_SCHEMAS[command],
      `${command} is not reference-equal to the wait module's own schema object`,
    );
  }
});

test('the projected family map declares exactly the commands its module owns', () => {
  for (const command of WAIT_COMMANDS) {
    assert.ok(
      ownerFilesForCommand(command).includes('src/commands/capture/wait.ts'),
      `${command} projects its output schema from this module but does not name it as its owner`,
    );
  }
});
