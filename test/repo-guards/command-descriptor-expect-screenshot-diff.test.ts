import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { CliFlags } from '@agent-device/contracts/command';
import {
  COMMAND_OUTPUT_SCHEMAS,
  findCommandMetadata,
  getCliCommandSchema,
  readInputFromCli,
  runCommand,
  type AgentDeviceClient,
  type CommandName,
} from '@agent-device/command-surface';
import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';

/**
 * The descriptor gate for `--expect-screenshot-diff` (press/click only), in the
 * style of the `--settle`/`--verify` descriptor gates under src/__tests__: every
 * caller-facing surface is pinned to the press/click scope, so a forgotten or
 * over-broad cell fails here instead of silently no-op'ing the flag — or
 * leaking it onto a command that never reads it. This is a repo-level guard on
 * command descriptors rather than a module's unit test, so it lives beside the
 * other guards.
 */

const SCREENSHOT_DIFF_COMMANDS = [PUBLIC_COMMANDS.click, PUBLIC_COMMANDS.press] as const;

const OUT_OF_SCOPE_COMMANDS = [
  PUBLIC_COMMANDS.longPress,
  PUBLIC_COMMANDS.hover,
  PUBLIC_COMMANDS.fill,
  PUBLIC_COMMANDS.scroll,
  PUBLIC_COMMANDS.back,
  PUBLIC_COMMANDS.swipe,
  PUBLIC_COMMANDS.type,
] as const;

const READER_POSITIONALS: Record<string, string[]> = {
  [PUBLIC_COMMANDS.click]: ['10', '20'],
  [PUBLIC_COMMANDS.press]: ['10', '20'],
};

// Targeted readers demand their target positionals, so each out-of-scope
// command names the positionals its own reader accepts.
const OUT_OF_SCOPE_READER_POSITIONALS: Record<string, string[]> = {
  [PUBLIC_COMMANDS.longPress]: ['10', '20'],
  [PUBLIC_COMMANDS.hover]: ['10', '20'],
  [PUBLIC_COMMANDS.fill]: ['10', '20', 'hello'],
  [PUBLIC_COMMANDS.scroll]: ['down'],
  [PUBLIC_COMMANDS.swipe]: ['30', '40', '50', '60'],
  [PUBLIC_COMMANDS.type]: ['hi'],
  [PUBLIC_COMMANDS.back]: [],
};

const FLAG_SNAPSHOT = { expectScreenshotDiff: true } as CliFlags;

test('expectScreenshotDiff CLI flags are scoped to press and click', () => {
  for (const command of SCREENSHOT_DIFF_COMMANDS) {
    const schema = getCliCommandSchema(command);
    assert.equal(
      (schema.allowedFlags ?? []).includes('expectScreenshotDiff'),
      true,
      `${command}: missing --expect-screenshot-diff`,
    );
  }
  for (const command of OUT_OF_SCOPE_COMMANDS) {
    const schema = getCliCommandSchema(command);
    assert.equal(
      (schema.allowedFlags ?? []).includes('expectScreenshotDiff'),
      false,
      `${command}: --expect-screenshot-diff must stay scoped to press/click`,
    );
  }
});

test('expectScreenshotDiff metadata fields are scoped to press and click', () => {
  for (const command of [...SCREENSHOT_DIFF_COMMANDS, ...OUT_OF_SCOPE_COMMANDS]) {
    const metadata = findCommandMetadata(command);
    if (!metadata) {
      throw new Error(`listed command ${command} carries no metadata; the guard cannot audit it`);
    }
    const properties = metadata.inputSchema.properties ?? {};
    assert.equal(
      Object.hasOwn(properties, 'expectScreenshotDiff'),
      command === PUBLIC_COMMANDS.click || command === PUBLIC_COMMANDS.press,
      `${command}: expectScreenshotDiff field presence must match the press/click scope`,
    );
  }
});

test('expectScreenshotDiff CLI reader input reaches only the press and click readers', () => {
  for (const [command, positionals] of Object.entries(READER_POSITIONALS)) {
    const input = readInputFromCli(command as CommandName, positionals, FLAG_SNAPSHOT);
    assert.equal(
      input.expectScreenshotDiff,
      true,
      `${command}: --expect-screenshot-diff must reach daemon input`,
    );
  }
  for (const command of OUT_OF_SCOPE_COMMANDS) {
    const positionals = OUT_OF_SCOPE_READER_POSITIONALS[command] ?? [];
    const input = readInputFromCli(command as CommandName, positionals, FLAG_SNAPSHOT);
    assert.equal(
      'expectScreenshotDiff' in input,
      false,
      `${command}: out-of-scope reader must ignore --expect-screenshot-diff`,
    );
  }
});

/** A client proxy that records the options of every method call at any depth. */
function recordingClient(calls: Array<Record<string, unknown>>): AgentDeviceClient {
  const surface: unknown = new Proxy(function () {}, {
    apply: (_target, _thisArg, args) => {
      calls.push(args[0] as Record<string, unknown>);
      return undefined;
    },
    get: () => surface,
  });
  return surface as AgentDeviceClient;
}

test('expectScreenshotDiff client option survives the press and click projections', async () => {
  for (const [command, positionals] of Object.entries(READER_POSITIONALS)) {
    const calls: Array<Record<string, unknown>> = [];
    await runCommand(
      recordingClient(calls),
      command as CommandName,
      readInputFromCli(command as CommandName, positionals, FLAG_SNAPSHOT),
    );
    assert.equal(calls.length, 1, `${command}: expected exactly one client call`);
    assert.equal(
      calls[0]?.expectScreenshotDiff,
      true,
      `${command}: expectScreenshotDiff option must survive projection`,
    );
  }
});

type SchemaView = {
  properties?: Record<string, unknown>;
  oneOf?: readonly SchemaView[];
};

function* propertyGroups(schema: SchemaView): Generator<Record<string, unknown>> {
  for (const branch of schema.oneOf ?? []) yield* propertyGroups(branch);
  if (schema.properties) yield schema.properties;
}

test('expectScreenshotDiff output schema covers press and click and no other command', () => {
  for (const [command, schema] of Object.entries(COMMAND_OUTPUT_SCHEMAS)) {
    const expected = command === PUBLIC_COMMANDS.click || command === PUBLIC_COMMANDS.press;
    let groups = 0;
    let hits = 0;
    for (const properties of propertyGroups(schema as SchemaView)) {
      groups += 1;
      if (Object.hasOwn(properties, 'screenshotDiff')) hits += 1;
    }
    assert.equal(
      hits > 0,
      expected,
      `${command}: screenshotDiff advertisement must match the press/click scope`,
    );
    if (expected) {
      assert.ok(groups > 0, `${command}: press/click schema must have object groups`);
    }
  }
});
