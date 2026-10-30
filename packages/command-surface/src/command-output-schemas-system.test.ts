import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  COMMAND_OWNER_FILES,
  ownerFilesForCommand,
} from '@agent-device/command-registry/owner-files';
import { SYSTEM_COMMAND_OUTPUT_SCHEMAS } from './system/index.ts';
import { COMMAND_OUTPUT_SCHEMAS } from './command-output-schemas.ts';

const SYSTEM_COMMANDS = Object.keys(SYSTEM_COMMAND_OUTPUT_SCHEMAS) as Array<
  keyof typeof SYSTEM_COMMAND_OUTPUT_SCHEMAS
>;

// `back` is the one entry in this family with a post-action observation trait (#1652): the
// composed map grafts a `settle` property onto a COPY, so it is not reference-equal to the
// module's own object. Every other entry in the family carries no such trait and must survive
// the spread untouched.
const SETTLE_DERIVED_COMMANDS = new Set(['back']);

test('MCP system family output schemas are the family module entries, not copies', () => {
  for (const command of SYSTEM_COMMANDS) {
    if (SETTLE_DERIVED_COMMANDS.has(command)) continue;
    assert.equal(
      COMMAND_OUTPUT_SCHEMAS[command],
      SYSTEM_COMMAND_OUTPUT_SCHEMAS[command],
      `${command} is not reference-equal to the system module's own schema object`,
    );
  }
});

test('a settle-derived system entry still grafts onto the module object, not a foreign copy', () => {
  const moduleBack = SYSTEM_COMMAND_OUTPUT_SCHEMAS.back;
  const derivedBack = COMMAND_OUTPUT_SCHEMAS.back;
  assert.notEqual(derivedBack, moduleBack, 'the derivation pass must copy, never mutate in place');
  assert.ok(derivedBack.properties?.settle);
  assert.equal(derivedBack.required, moduleBack.required, 'required list is not re-derived');
  assert.equal(
    derivedBack.properties?.mode,
    moduleBack.properties?.mode,
    'a field object nested under the derived copy must still be the module property, not a rebuild',
  );
});

test('every system-owned command claims this module, and the module claims nothing else', () => {
  for (const command of SYSTEM_COMMANDS) {
    assert.ok(
      ownerFilesForCommand(command).includes('packages/command-surface/src/system/index.ts'),
      `${command} projects its output schema from this module but does not name it as its owner`,
    );
  }

  const commandsOwnedByThisModule = (
    Object.entries(COMMAND_OWNER_FILES) as Array<[string, readonly string[]]>
  )
    .filter(([, ownerFiles]) => ownerFiles.includes('packages/command-surface/src/system/index.ts'))
    .map(([command]) => command)
    .sort();
  assert.deepEqual(
    commandsOwnedByThisModule,
    [...SYSTEM_COMMANDS].sort(),
    'a command the registry attributes to this module is missing from SYSTEM_COMMAND_OUTPUT_SCHEMAS (or vice versa)',
  );
});
