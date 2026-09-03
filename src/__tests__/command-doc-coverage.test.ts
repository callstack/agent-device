import fs from 'node:fs';
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { PUBLIC_COMMANDS, isKnownCliCommandName } from '../command-catalog.ts';
import { cliCommandAlias } from '../commands/cli-command-aliases.ts';
import { getCliCommandSchema } from '../cli-schema/command-schema.ts';
import { buildCommandUsage } from '../cli-schema/usage.ts';

// Enumerates the public command surface (`PUBLIC_COMMANDS`, derived from the
// command descriptor registry) against the human-facing command reference at
// `website/docs/docs/commands.md`, in both directions:
//   forward  — every public command is shown as an `agent-device <command>` usage
//              line, so a new public command cannot ship without a docs entry.
//   reverse  — every `agent-device <command>` token documented in a code block is
//              a real registry command (or CLI alias), so retiring a command with
//              stale docs fails symmetrically.
// Intentional omissions live in the waiver lists below with a reason; a stale
// waiver (one whose target is already documented / already a registry command)
// fails so the waiver list cannot silently rot.
const COMMANDS_DOC_PATH = 'website/docs/docs/commands.md';

type CommandDocWaiver = { command: string; reason: string };

// Public commands intentionally absent from commands.md. Each entry needs a
// reason. Empty today: every public command is documented (see the drift fixed
// in this change — `doctor` and `react-native`).
const UNDOCUMENTED_PUBLIC_COMMAND_WAIVERS: readonly CommandDocWaiver[] = [];

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

// Locates a verbatim executable usage line inside a code block. Command names
// are covered by the token checks above; this is the stricter per-command gate
// that keeps a published invocation identical to the schema that produces it.
function findUsageLine(markdown: string, usageLine: string): number | undefined {
  for (const { text, lineNumber } of fencedLines(markdown)) {
    if (text.trim() === usageLine) return lineNumber;
  }
  return undefined;
}

// The canonical `snapshot` invocation, derived from the command schema rather
// than restated here: `snapshot` grew `--actions`, `--force-full`, and
// `--timeout` while the command reference still published a three-flag usage
// line, so the flag list must stay owned by the schema.
function canonicalSnapshotUsageLine(): string {
  return `agent-device ${buildCommandUsage('snapshot', getCliCommandSchema('snapshot'))}`;
}

function isRegistryCommandToken(token: string): boolean {
  return isKnownCliCommandName(token) || cliCommandAlias(token) !== undefined;
}

function findUndocumentedPublicCommands(
  publicCommands: readonly string[],
  documented: ReadonlyMap<string, number>,
  waivers: readonly CommandDocWaiver[],
): string[] {
  const waived = new Set(waivers.map((waiver) => waiver.command));
  return publicCommands
    .filter((command) => !documented.has(command) && !waived.has(command))
    .sort();
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

function findStaleUndocumentedWaivers(
  publicCommands: readonly string[],
  documented: ReadonlyMap<string, number>,
  waivers: readonly CommandDocWaiver[],
): string[] {
  const publicSet = new Set(publicCommands);
  return waivers
    .filter((waiver) => !publicSet.has(waiver.command) || documented.has(waiver.command))
    .map((waiver) => waiver.command)
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

function undocumentedMessage(missing: readonly string[]): string {
  return (
    `${COMMANDS_DOC_PATH} is missing documentation for public command(s): ${missing.join(', ')}. ` +
    'Add an `agent-device <command>` usage line inside a code block, or add a waiver with a ' +
    'reason to UNDOCUMENTED_PUBLIC_COMMAND_WAIVERS.'
  );
}

function canonicalUsageMessage(usageLine: string): string {
  return (
    `${COMMANDS_DOC_PATH} does not publish the canonical usage line \`${usageLine}\`. ` +
    'The command schema owns CLI syntax: update the documented code block to match it rather ' +
    'than editing this expectation.'
  );
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
const publicCommands = Object.values(PUBLIC_COMMANDS);

describe('command reference doc coverage', () => {
  test('every public command is documented in commands.md', () => {
    const missing = findUndocumentedPublicCommands(
      publicCommands,
      documentedCommands,
      UNDOCUMENTED_PUBLIC_COMMAND_WAIVERS,
    );
    assert.deepEqual(missing, [], undocumentedMessage(missing));
  });

  test('every documented command token resolves to a registry command', () => {
    const unknown = findUnknownDocumentedCommands(
      documentedCommands,
      isRegistryCommandToken,
      UNKNOWN_DOCUMENTED_COMMAND_WAIVERS,
    );
    assert.deepEqual(unknown, [], unknownMessage(unknown));
  });

  test('commands.md publishes the canonical snapshot CLI usage', () => {
    const usageLine = canonicalSnapshotUsageLine();
    assert.notEqual(
      findUsageLine(markdown, usageLine),
      undefined,
      canonicalUsageMessage(usageLine),
    );
  });

  test('commands.md publishes the wait absence unreadable-observation reason', () => {
    assert.match(
      markdown,
      /`?predicate_failed`? means strict `wait absent` could not prove absence because no valid capture arrived/,
    );
  });

  test('no stale waivers', () => {
    assert.deepEqual(
      findStaleUndocumentedWaivers(
        publicCommands,
        documentedCommands,
        UNDOCUMENTED_PUBLIC_COMMAND_WAIVERS,
      ),
      [],
      'UNDOCUMENTED_PUBLIC_COMMAND_WAIVERS has entries that are documented or not public commands.',
    );
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

  test('adding a public command without touching commands.md fails, naming file and command', () => {
    const withNewCommand = [...publicCommands, 'brand-new-command'];
    const missing = findUndocumentedPublicCommands(
      withNewCommand,
      documentedCommands,
      UNDOCUMENTED_PUBLIC_COMMAND_WAIVERS,
    );
    assert.deepEqual(missing, ['brand-new-command']);
    const message = undocumentedMessage(missing);
    assert.match(message, /website\/docs\/docs\/commands\.md/);
    assert.match(message, /brand-new-command/);
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

  test('a drifted snapshot usage line fails, naming file and canonical usage', () => {
    const usageLine = canonicalSnapshotUsageLine();
    const driftedDocs = markdown.replaceAll(usageLine, 'agent-device snapshot [-i]');
    assert.equal(findUsageLine(driftedDocs, usageLine), undefined);
    const message = canonicalUsageMessage(usageLine);
    assert.match(message, /website\/docs\/docs\/commands\.md/);
    assert.ok(message.includes(usageLine), 'the failure names the usage line the schema produces');
  });

  test('a waiver suppresses an intentional forward omission', () => {
    const withNewCommand = [...publicCommands, 'deliberately-hidden'];
    const missing = findUndocumentedPublicCommands(withNewCommand, documentedCommands, [
      { command: 'deliberately-hidden', reason: 'covered by a dedicated guide, out of scope here' },
    ]);
    assert.deepEqual(missing, []);
  });

  test('a stale forward waiver is reported', () => {
    const documentedPublic = publicCommands.find((command) => documentedCommands.has(command));
    assert.ok(documentedPublic, 'expected at least one documented public command');
    const stale = findStaleUndocumentedWaivers(publicCommands, documentedCommands, [
      { command: documentedPublic, reason: 'no longer accurate — command is documented' },
    ]);
    assert.deepEqual(stale, [documentedPublic]);
  });
});
