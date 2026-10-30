import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  INTERNAL_COMMANDS,
  isKnownCliCommandName,
  listCliCommandNames,
  SPECIAL_CLI_COMMANDS,
} from '@agent-device/command-registry/catalog';
import { listRuntimeFactCommands } from '@agent-device/command-registry/registry';
import { getCliCommandSchema } from './command-schema.ts';

test('every public runtime-fact command has a parser schema entry', () => {
  const schemaCommands = new Set<string>(listCliCommandNames());
  for (const command of listRuntimeFactCommands()) {
    assert.equal(schemaCommands.has(command), true, `Missing schema for command: ${command}`);
  }
});

test('every CLI command has a derived or local parser schema entry', () => {
  for (const command of listCliCommandNames()) {
    assert.doesNotThrow(
      () => getCliCommandSchema(command),
      `Missing schema for command: ${command}`,
    );
  }
});

test('known CLI command predicate covers catalog, help, and internal commands', () => {
  for (const command of listCliCommandNames()) {
    assert.equal(isKnownCliCommandName(command), true, `Missing CLI command: ${command}`);
  }
  for (const command of Object.values(SPECIAL_CLI_COMMANDS)) {
    assert.equal(isKnownCliCommandName(command), true, `Missing special command: ${command}`);
  }
  for (const command of Object.values(INTERNAL_COMMANDS)) {
    assert.equal(isKnownCliCommandName(command), true, `Missing internal command: ${command}`);
  }
  assert.equal(isKnownCliCommandName('tap'), false);
  assert.equal(isKnownCliCommandName('not-a-command'), false);
});
