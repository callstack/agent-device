import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ownerFilesForCommand } from '@agent-device/command-registry/owner-files';
import { INTERACTION_COMMAND_OUTPUT_SCHEMAS } from '../../commands/interaction/index.ts';
import { COMMAND_OUTPUT_SCHEMAS } from '../command-output-schemas.ts';

const INTERACTION_COMMANDS = Object.keys(INTERACTION_COMMAND_OUTPUT_SCHEMAS) as Array<
  keyof typeof INTERACTION_COMMAND_OUTPUT_SCHEMAS
>;

// press, click, fill, longpress, and hover carry the post-action observation trait (#1652): the
// composed map grafts a `settle` property onto a COPY, so they are not reference-equal to the
// module's own object. find carries no such trait.
const SETTLE_DERIVED_COMMANDS = new Set(['press', 'click', 'fill', 'longpress', 'hover']);

test('MCP interaction family output schemas are the family module entries, not copies', () => {
  for (const command of INTERACTION_COMMANDS) {
    if (SETTLE_DERIVED_COMMANDS.has(command)) continue;
    assert.equal(
      COMMAND_OUTPUT_SCHEMAS[command],
      INTERACTION_COMMAND_OUTPUT_SCHEMAS[command],
      `${command} is not reference-equal to the interaction module's own schema object`,
    );
  }
});

test('a settle-derived interaction entry still grafts onto the module object, not a foreign copy', () => {
  const modulePress = INTERACTION_COMMAND_OUTPUT_SCHEMAS.press;
  const derivedPress = COMMAND_OUTPUT_SCHEMAS.press;
  assert.notEqual(
    derivedPress,
    modulePress,
    'the derivation pass must copy, never mutate in place',
  );
  assert.equal(derivedPress.required, modulePress.required, 'required list is not re-derived');
  assert.equal(
    derivedPress.properties?.targetKind,
    modulePress.properties?.targetKind,
    'a field object nested under the derived copy must still be the module property, not a rebuild',
  );
  assert.ok(
    derivedPress.properties?.settle,
    'the settle-capable command must carry the grafted observation property',
  );
});

test('press and click share the same tap response schema object', () => {
  assert.equal(INTERACTION_COMMAND_OUTPUT_SCHEMAS.press, INTERACTION_COMMAND_OUTPUT_SCHEMAS.click);
});

test('the projected family map declares exactly the commands its module owns', () => {
  for (const command of INTERACTION_COMMANDS) {
    assert.ok(
      ownerFilesForCommand(command).includes('src/commands/interaction/index.ts'),
      `${command} projects its output schema from this module but does not name it as its owner`,
    );
  }
});
