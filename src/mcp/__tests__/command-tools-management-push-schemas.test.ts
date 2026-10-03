import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ownerFilesForCommand } from '@agent-device/command-registry/owner-files';
import { PUSH_MANAGEMENT_COMMAND_OUTPUT_SCHEMAS } from '../../commands/management/push.ts';
import { COMMAND_OUTPUT_SCHEMAS } from '../command-output-schemas.ts';

const PUSH_MANAGEMENT_COMMANDS = Object.keys(PUSH_MANAGEMENT_COMMAND_OUTPUT_SCHEMAS) as Array<
  keyof typeof PUSH_MANAGEMENT_COMMAND_OUTPUT_SCHEMAS
>;

// Neither push nor trigger-app-event carries the post-action observation trait (#1652): both
// fire-and-report a push delivery or an app event, not an interaction, so the composed map never
// copies either entry and reference equality must hold for both.
test('MCP push management family output schemas are the family module entries, not copies', () => {
  for (const command of PUSH_MANAGEMENT_COMMANDS) {
    assert.equal(
      COMMAND_OUTPUT_SCHEMAS[command],
      PUSH_MANAGEMENT_COMMAND_OUTPUT_SCHEMAS[command],
      `${command} is not reference-equal to the push management module's own schema object`,
    );
  }
});

test('the projected family map declares exactly the commands its module owns', () => {
  for (const command of PUSH_MANAGEMENT_COMMANDS) {
    assert.ok(
      ownerFilesForCommand(command).includes('src/commands/management/push.ts'),
      `${command} projects its output schema from this module but does not name it as its owner`,
    );
  }
});
