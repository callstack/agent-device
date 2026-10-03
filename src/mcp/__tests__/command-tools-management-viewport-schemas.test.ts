import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ownerFilesForCommand } from '@agent-device/command-registry/owner-files';
import { VIEWPORT_COMMAND_OUTPUT_SCHEMAS } from '../../commands/management/viewport.ts';
import { COMMAND_OUTPUT_SCHEMAS } from '../command-output-schemas.ts';

const VIEWPORT_COMMANDS = Object.keys(VIEWPORT_COMMAND_OUTPUT_SCHEMAS) as Array<
  keyof typeof VIEWPORT_COMMAND_OUTPUT_SCHEMAS
>;

// viewport does not carry the post-action observation trait (#1652): it fire-and-reports a
// viewport resize, not an interaction, so the composed map never copies the entry and reference
// equality must hold.
test('MCP viewport family output schemas are the family module entries, not copies', () => {
  for (const command of VIEWPORT_COMMANDS) {
    assert.equal(
      COMMAND_OUTPUT_SCHEMAS[command],
      VIEWPORT_COMMAND_OUTPUT_SCHEMAS[command],
      `${command} is not reference-equal to the viewport module's own schema object`,
    );
  }
});

test('the projected family map declares exactly the commands its module owns', () => {
  for (const command of VIEWPORT_COMMANDS) {
    assert.ok(
      ownerFilesForCommand(command).includes('src/commands/management/viewport.ts'),
      `${command} projects its output schema from this module but does not name it as its owner`,
    );
  }
});
