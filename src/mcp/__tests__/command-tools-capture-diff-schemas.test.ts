import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ownerFilesForCommand } from '@agent-device/command-registry/owner-files';
import { DIFF_COMMAND_OUTPUT_SCHEMAS } from '../../commands/capture/diff.ts';
import { COMMAND_OUTPUT_SCHEMAS } from '../command-output-schemas.ts';

const DIFF_COMMANDS = Object.keys(DIFF_COMMAND_OUTPUT_SCHEMAS) as Array<
  keyof typeof DIFF_COMMAND_OUTPUT_SCHEMAS
>;

// diff does not carry the post-action observation trait (#1652): it reports a snapshot
// comparison, not an interaction, so the composed map never copies the entry and reference
// equality must hold.
test('MCP diff family output schemas are the family module entries, not copies', () => {
  for (const command of DIFF_COMMANDS) {
    assert.equal(
      COMMAND_OUTPUT_SCHEMAS[command],
      DIFF_COMMAND_OUTPUT_SCHEMAS[command],
      `${command} is not reference-equal to the diff module's own schema object`,
    );
  }
});

test('the projected family map declares exactly the commands its module owns', () => {
  for (const command of DIFF_COMMANDS) {
    assert.ok(
      ownerFilesForCommand(command).includes('src/commands/capture/diff.ts'),
      `${command} projects its output schema from this module but does not name it as its owner`,
    );
  }
});

test('the diff line kinds include unchanged context lines', () => {
  const lines = (
    DIFF_COMMAND_OUTPUT_SCHEMAS.diff as unknown as {
      properties: { lines: { items: { properties: { kind: { enum: string[] } } } } };
    }
  ).properties.lines.items.properties.kind;
  assert.deepEqual(lines.enum, ['added', 'removed', 'unchanged']);
});
