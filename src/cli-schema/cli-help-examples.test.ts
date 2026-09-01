import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { BatchStep } from '@agent-device/contracts/client';
import { parseArgs } from '../cli/parser/args.ts';
import { readCliBatchStepsJson } from '../cli/batch-steps.ts';
import { buildCommandUsageText, buildUsageText, helpTopicIds } from './cli-help.ts';
import { listCliCommandNames } from '../command-catalog.ts';
import { readInputFromCli } from '../commands/cli-grammar.ts';
import { findCommandMetadata, isCommandName } from '../commands/command-metadata.ts';
import { readVersion } from '@agent-device/host-kit/version';

// Help is the agent-facing contract, and agents copy its example lines verbatim, so an example the
// CLI schema rejects is a broken command surface — not a docs nit (#1765: `help react-native`
// advertised `open --metro-host/--metro-port` for four releases before `open` accepted them).
// The example set cannot be enumerated from a hand-written list without drifting from the text that
// actually ships, so it is read back out of the rendered help itself: every line that starts with
// `agent-device ` is either a runnable example or a synopsis shape, and shapes are exactly the ones
// carrying placeholder syntax in an unquoted token (`<value>`, `[optional]`, `a|b`). Runnable ones
// go through the production parser plus the command's CLI reader.
//
// Boundary: only line-leading examples are checked. Examples embedded mid-sentence in a command's
// detail prose have no reliable end delimiter (`127.0.0.1`, `flow.log` and a sentence-final period
// are indistinguishable), so they stay out rather than guessing where the command stops.

const PLACEHOLDER_SYNTAX = /[<>[\]|]/;

type Token = { value: string; quoted: boolean };

type HelpExample = { surface: string; line: string; argv: string[] };

const TOKEN_PATTERN = /'([^']*)'|"([^"]*)"|(\S+)/g;

/** Shell-style split that remembers quoting, so `--steps '[{"command":…}]'` stays one argument. */
function tokenize(line: string): Token[] {
  return [...line.matchAll(TOKEN_PATTERN)].map(([, single, double, bare]) => {
    const quoted = single ?? double;
    return quoted === undefined ? { value: bare!, quoted: false } : { value: quoted, quoted: true };
  });
}

/** Every help text a `--help`/`help <topic>` call can print, keyed by the argument that prints it. */
function helpSurfaces(): Array<{ name: string; lines: string[] }> {
  const topics = new Set(helpTopicIds());
  const surfaces = [{ name: 'help', lines: buildUsageText().split('\n') }];
  for (const topic of topics) {
    const text = buildCommandUsageText(topic);
    assert.ok(text, `Expected help text for topic ${topic}`);
    const lines = text.split('\n');
    // `withVersionHeader` swaps the authored `agent-device help <topic>` first line for a version
    // banner. Drop it by construction (asserted, so a format change cannot silently swallow a real
    // example line here instead).
    assert.equal(lines[0], `agent-device ${readVersion()} — ${topic}`);
    surfaces.push({ name: topic, lines: lines.slice(1) });
  }
  for (const command of listCliCommandNames()) {
    if (topics.has(command)) continue;
    const text = buildCommandUsageText(command);
    if (text) surfaces.push({ name: command, lines: text.split('\n') });
  }
  return surfaces;
}

function collectHelpExamples(): HelpExample[] {
  const examples: HelpExample[] = [];
  for (const surface of helpSurfaces()) {
    for (const rawLine of surface.lines) {
      const line = rawLine.trim();
      if (!line.startsWith('agent-device ')) continue;
      const tokens = tokenize(line).slice(1);
      // Whole-token quoting is the only shape modelled; a quote inside a bare token (`--k='a b'`)
      // would split wrong, so fail loudly rather than parse garbage.
      assert.ok(
        !tokens.some((token) => !token.quoted && /['"]/.test(token.value)),
        `Unsupported quoting in help example: ${line}`,
      );
      if (tokens.some((token) => !token.quoted && PLACEHOLDER_SYNTAX.test(token.value))) continue;
      examples.push({
        surface: surface.name,
        line,
        argv: tokens.map((token) => token.value),
      });
    }
  }
  return examples;
}

function checkExample(example: HelpExample): string | null {
  try {
    const parsed = parseArgs(example.argv, { strictFlags: true });
    if (parsed.command && isCommandName(parsed.command)) {
      readInputFromCli(parsed.command, parsed.positionals, parsed.flags);
    }
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[help ${example.surface}] ${example.line}\n    ${message}`;
  }
}

test('every runnable example printed by CLI help is accepted by the CLI schema', () => {
  const failures = collectHelpExamples()
    .map(checkExample)
    .filter((failure): failure is string => failure !== null);
  assert.deepEqual(
    failures,
    [],
    `Help advertises commands the CLI rejects:\n${failures.join('\n')}`,
  );
});

/** The `--steps` payload of every batch example help prints, paired with the line it came from. */
function collectBatchStepExamples(): Array<{ line: string; steps: BatchStep[] }> {
  return collectHelpExamples()
    .filter((example) => example.argv[0] === 'batch' && example.argv.includes('--steps'))
    .map((example) => {
      const json = example.argv[example.argv.indexOf('--steps') + 1];
      assert.ok(json, `Expected a --steps payload in help example: ${example.line}`);
      return { line: example.line, steps: readCliBatchStepsJson(json) };
    });
}

// A step's `input` is keyed by the command's structured field names, and no CLI help text spells
// those out — `help press` documents the positional and the flags, not `target: {kind, ref}`. So
// the printed steps ARE the terminal's only statement of them, and the check above cannot see it:
// the CLI parser validates the step envelope and stops, never reading `input`. Each printed input
// therefore goes through its own command's `readInput` — the same reader the daemon, the client,
// and the MCP tool run (#2062).
test('every batch step printed by CLI help is accepted by its own command reader', () => {
  const examples = collectBatchStepExamples();
  const covered = new Set<string>();
  for (const { line, steps } of examples) {
    for (const step of steps) {
      assert.ok(isCommandName(step.command), `Unknown command in help example: ${line}`);
      let parsed: unknown;
      try {
        parsed = findCommandMetadata(step.command).readInput(step.input);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        assert.fail(
          `Help advertises a batch step ${step.command} rejects:\n${line}\n    ${message}`,
        );
      }
      // readInput IGNORES unknown keys, so acceptance alone cannot pin an optional field: a
      // renamed `settle` or `interactiveOnly` would parse to a step that silently does less
      // than the help advertises. Every printed key must survive into the parsed input.
      assert.deepEqual(
        Object.keys(parsed as Record<string, unknown>).sort(),
        Object.keys(step.input).sort(),
        `Help advertises a batch step ${step.command} key its reader drops:\n${line}`,
      );
      covered.add(step.command);
    }
  }
  // #2062 was reported against the mutating verbs; a snapshot step is what precedes them.
  for (const command of ['press', 'fill', 'snapshot']) {
    assert.ok(covered.has(command), `Expected a ${command} step among help's batch examples`);
  }
});

test('help react-native keeps its multi-worktree open example runnable', () => {
  const examples = collectHelpExamples().filter(
    (example) => example.surface === 'react-native' && example.argv.includes('--metro-port'),
  );
  assert.equal(examples.length, 2);
  for (const example of examples) {
    const parsed = parseArgs(example.argv, { strictFlags: true });
    assert.equal(parsed.command, 'open');
    assert.equal(parsed.flags.metroHost, '127.0.0.1');
    assert.equal(typeof parsed.flags.metroPort, 'number');
  }
});

test('help macos keeps its menu bar example runnable', () => {
  const examples = collectHelpExamples().filter((example) => example.surface === 'macos');
  const surfaceExamples = examples.filter((example) => example.argv.includes('--surface'));
  assert.ok(surfaceExamples.length > 0, 'Expected a macos --surface example');
  // The surface is bound once by open and kept on the session (`snapshot-capture.ts` reads
  // `session.surface`), so only open takes --surface.
  assert.deepEqual([...new Set(surfaceExamples.map((example) => example.argv[0]))], ['open']);
  assert.ok(examples.some((example) => example.argv[0] === 'snapshot'));
});
