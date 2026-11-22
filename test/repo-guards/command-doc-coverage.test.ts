import fs from 'node:fs';
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { isKnownCliCommandName } from '@agent-device/command-registry/catalog';
import { cliCommandAlias } from '@agent-device/command-registry/cli-command-aliases';

// Every `agent-device <command>` token documented in a code block of the command reference must be
// a real registry command or CLI alias, so retiring a command with stale docs fails. That every
// public command is documented is the generated-block guard's job
// (command-doc-generated-blocks.test.ts). Intentional omissions live in the waiver list below with
// a reason; a stale waiver fails so the list cannot silently rot.
const COMMANDS_DOC_PATH = 'website/docs/docs/commands.md';

type CommandDocWaiver = { command: string; reason: string };

// `agent-device <token>` invocations documented in commands.md that intentionally
// do not resolve to a registry command name or CLI alias (e.g. a documented
// companion binary). Empty today.
const UNKNOWN_DOCUMENTED_COMMAND_WAIVERS: readonly CommandDocWaiver[] = [];

// Yields the lines inside fenced code blocks with their 1-based line numbers.
// Prose outside code fences is skipped on purpose: only executable usage lines
// count as "documenting" a command, so a passing reference like "the effective
// agent-device state dir" is not read as an `agent-device state` command.
function* fencedLines(markdown: string): Generator<{ text: string; lineNumber: number }> {
  let insideFence = false;
  const lines = markdown.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index] ?? '';
    if (/^\s*(?:```|~~~)/.test(text)) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) yield { text, lineNumber: index + 1 };
  }
}

// Extracts the set of `agent-device <token>` command tokens documented inside
// fenced code blocks, mapped to the 1-based line where each first appears.
function extractDocumentedCommandTokens(markdown: string): Map<string, number> {
  const documented = new Map<string, number>();
  for (const { text, lineNumber } of fencedLines(markdown)) {
    const token = /^\s*agent-device\s+([a-z0-9-]+)/.exec(text)?.[1];
    if (token !== undefined && !documented.has(token)) {
      documented.set(token, lineNumber);
    }
  }
  return documented;
}

function isRegistryCommandToken(token: string): boolean {
  return isKnownCliCommandName(token) || cliCommandAlias(token) !== undefined;
}

function findUnknownDocumentedCommands(
  documented: ReadonlyMap<string, number>,
  isRegistryToken: (token: string) => boolean,
  waivers: readonly CommandDocWaiver[],
): string[] {
  const waived = new Set(waivers.map((waiver) => waiver.command));
  return [...documented.keys()]
    .filter((token) => !isRegistryToken(token) && !waived.has(token))
    .sort();
}

function findStaleUnknownWaivers(
  documented: ReadonlyMap<string, number>,
  isRegistryToken: (token: string) => boolean,
  waivers: readonly CommandDocWaiver[],
): string[] {
  return waivers
    .filter((waiver) => !documented.has(waiver.command) || isRegistryToken(waiver.command))
    .map((waiver) => waiver.command)
    .sort();
}

function unknownMessage(unknown: readonly string[]): string {
  return (
    `${COMMANDS_DOC_PATH} documents command token(s) absent from the command registry: ` +
    `${unknown.join(', ')}. Remove the stale docs, restore the command, or add a waiver with a ` +
    'reason to UNKNOWN_DOCUMENTED_COMMAND_WAIVERS.'
  );
}

const markdown = fs.readFileSync(COMMANDS_DOC_PATH, 'utf8');
const documentedCommands = extractDocumentedCommandTokens(markdown);

describe('command reference doc coverage', () => {
  test('every documented command token resolves to a registry command', () => {
    const unknown = findUnknownDocumentedCommands(
      documentedCommands,
      isRegistryCommandToken,
      UNKNOWN_DOCUMENTED_COMMAND_WAIVERS,
    );
    assert.deepEqual(unknown, [], unknownMessage(unknown));
  });

  test('commands.md publishes the wait absence unreadable-observation reason', () => {
    assert.match(
      markdown,
      /`?predicate_failed`? means strict `wait absent` could not prove absence because no valid capture arrived/,
    );
  });

  test('no stale waivers', () => {
    assert.deepEqual(
      findStaleUnknownWaivers(
        documentedCommands,
        isRegistryCommandToken,
        UNKNOWN_DOCUMENTED_COMMAND_WAIVERS,
      ),
      [],
      'UNKNOWN_DOCUMENTED_COMMAND_WAIVERS has entries that are documented registry commands.',
    );
  });
});

describe('command reference doc coverage gate behavior', () => {
  test('extraction reads only fenced agent-device usage lines', () => {
    const sample = [
      '# Title',
      '',
      'Prose that says `agent-device state dir` must not count.',
      'agent-device home outside a fence must not count either.',
      '',
      '```bash',
      'agent-device boot --platform ios',
      'agent-device web doctor',
      'vega virtual-device start',
      '```',
    ].join('\n');
    const tokens = extractDocumentedCommandTokens(sample);
    assert.deepEqual([...tokens.keys()].sort(), ['boot', 'web']);
    assert.equal(tokens.get('boot'), 7);
  });

  test('extraction also recognizes tilde-fenced code blocks', () => {
    const sample = ['~~~bash', 'agent-device snapshot -i', '~~~'].join('\n');
    const tokens = extractDocumentedCommandTokens(sample);
    assert.deepEqual([...tokens.keys()], ['snapshot']);
  });

  test('retiring a command with stale docs fails symmetrically, naming file and command', () => {
    const staleDocs = new Map(documentedCommands);
    staleDocs.set('retired-command', 999);
    const unknown = findUnknownDocumentedCommands(
      staleDocs,
      isRegistryCommandToken,
      UNKNOWN_DOCUMENTED_COMMAND_WAIVERS,
    );
    assert.deepEqual(unknown, ['retired-command']);
    const message = unknownMessage(unknown);
    assert.match(message, /website\/docs\/docs\/commands\.md/);
    assert.match(message, /retired-command/);
  });
});
