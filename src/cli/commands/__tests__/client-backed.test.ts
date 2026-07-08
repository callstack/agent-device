import assert from 'node:assert/strict';
import { test } from 'vitest';
import { listCliCommandNames } from '../../../command-catalog.ts';
import { listExecutableCommandNames } from '../../../commands/command-surface.ts';
import { isClientBackedCliCommandName } from '../client-backed.ts';

test('client-backed CLI command routing follows executable command metadata', () => {
  const executableCommands = new Set<string>(listExecutableCommandNames());

  for (const command of executableCommands) {
    assert.equal(
      isClientBackedCliCommandName(command),
      true,
      `${command} should route through the command-family client surface`,
    );
  }

  for (const command of listCliCommandNames()) {
    assert.equal(
      isClientBackedCliCommandName(command),
      executableCommands.has(command),
      `${command} client-backed routing should match command-family executable metadata`,
    );
  }
});
