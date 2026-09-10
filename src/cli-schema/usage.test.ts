import assert from 'node:assert/strict';
import { test } from 'vitest';
import { listCliCommandNames } from '@agent-device/command-registry/catalog';
import type { CommandText } from '../commands/command-text.ts';
import {
  getCliCommandSchema,
  getFlagDefinitions,
  type CommandSchema,
  type FlagDefinition,
  type FlagKey,
} from './command-schema.ts';
import { buildCommandUsage } from './usage.ts';

const TEXT: CommandText = {
  summary: 'Synopsis fixture',
  description: 'Synthetic grammar used to pin synopsis rendering rules.',
};

function synopsisFor(grammar: Omit<CommandSchema, 'text'>): string {
  return buildCommandUsage('sample', { text: TEXT, ...grammar });
}

function flagDefinitionsFor(key: FlagKey): FlagDefinition[] {
  return getFlagDefinitions().filter((definition) => definition.key === key);
}

/** The options a synopsis names in its generated flag tail. */
function tailFlags(schema: CommandSchema): readonly FlagKey[] {
  return schema.usageFlags ?? schema.allowedFlags ?? [];
}

/** A synopsis names an option by one of its CLI tokens, delimited so `--settle` is not `--settle-quiet`. */
function namesOption(synopsis: string, definition: FlagDefinition): boolean {
  // Flag tokens are letters, digits and dashes, so the name needs no escaping here.
  return definition.names.some((name) =>
    new RegExp(String.raw`(?<![\w-])${name}(?![\w-])`).test(synopsis),
  );
}

test('synopsis names each tailed option with its declared label, aliases included', () => {
  assert.equal(
    synopsisFor({ allowedFlags: ['snapshotDepth', 'snapshotInteractiveOnly', 'timeoutMs'] }),
    'sample [--depth, -d <depth>] [-i] [--timeout <ms>]',
  );
});

test('synopsis omits a hidden option and an option with no CLI token', () => {
  assert.equal(synopsisFor({ allowedFlags: ['snapshotDiff', 'record'] }), 'sample [--diff]');
  assert.equal(synopsisFor({ allowedFlags: ['snapshotDiff', 'installSource'] }), 'sample [--diff]');
});

test('synopsis renders positionals before the flag tail', () => {
  assert.equal(
    synopsisFor({ positionalArgs: ['kind', 'current?'], allowedFlags: ['threshold'] }),
    'sample <kind> [current] [--threshold <0-1>]',
  );
});

test('usageFlags chooses the tail and a hand-written grammar keeps it generated', () => {
  assert.equal(
    synopsisFor({
      usageOverride: 'sample first|second [--exclusive-a | --exclusive-b]',
      usageFlags: ['threshold'],
      allowedFlags: ['threshold', 'out'],
    }),
    'sample first|second [--exclusive-a | --exclusive-b] [--threshold <0-1>]',
  );
  assert.equal(
    synopsisFor({ usageOverride: 'sample only <arg>', usageFlags: [], allowedFlags: ['out'] }),
    'sample only <arg>',
  );
});

test('snapshot synopsis is generated from its allowed flags', () => {
  const schema = getCliCommandSchema('snapshot');
  assert.equal(schema.usageOverride, undefined);
  assert.equal(
    buildCommandUsage('snapshot', schema),
    'snapshot [--diff] [-i] [--depth, -d <depth>] [--scope, -s <scope>] [--raw] [--actions] [--force-full] [--timeout <ms>]',
  );
});

test('a synopsis names no option its command refuses', () => {
  const offenders = listCliCommandNames().flatMap((command) => {
    const schema = getCliCommandSchema(command);
    const accepted = new Set<FlagKey>(schema.allowedFlags ?? []);
    const unaccepted = tailFlags(schema).filter((key) => !accepted.has(key));
    if (unaccepted.length === 0) return [];
    return [`${command} tails ${unaccepted.join(', ')} outside its allowedFlags`];
  });
  assert.deepEqual(
    offenders,
    [],
    'usageFlags is the tail of allowedFlags: an option the synopsis names must be one the ' +
      'command parses. Add it to allowedFlags or drop it from usageFlags.',
  );
});

test('a generated flag tail repeats no bracket the grammar already wrote', () => {
  const offenders: string[] = [];
  for (const command of listCliCommandNames()) {
    const authored = getCliCommandSchema(command).usageOverride;
    if (authored === undefined) continue;
    const schema = getCliCommandSchema(command);
    const repeated = tailFlags(schema).filter((key) =>
      flagDefinitionsFor(key).some((definition) => namesOption(authored, definition)),
    );
    if (repeated.length > 0) offenders.push(`${command}: ${repeated.join(', ')}`);
  }
  assert.deepEqual(
    offenders,
    [],
    'A hand-written grammar that names an option leaves it out of usageFlags, so the tail ' +
      'generated after it renders that option exactly once.',
  );
});

test('an authored synopsis is not empty', () => {
  const offenders = listCliCommandNames().filter((command) => {
    const authored = getCliCommandSchema(command).usageOverride;
    return authored !== undefined && authored.trim().length === 0;
  });
  assert.deepEqual(
    offenders,
    [],
    'An empty usageOverride suppresses the whole synopsis; delete the field instead.',
  );
});
