import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { CliFlags } from '@agent-device/contracts/command';
import type { SessionAction } from '@agent-device/contracts/session';
import { PUBLIC_COMMANDS } from '../../../command-catalog.ts';
import type { AgentDeviceClient } from '../../../agent-device-client.ts';
import { findCommandMetadata, type CommandName } from '../../../commands/command-metadata.ts';
import { readInputFromCli } from '../../../commands/cli-grammar/registry.ts';
import {
  listCommandFamilyCliOutputFormatters,
  listCommandFamilyDefinitions,
} from '../../../commands/family/registry.ts';
import type { SettleCapableClientOptionCommands } from '../../../commands/post-action-observation-client-options.ts';
import { getCliCommandSchema } from '../../../cli-schema/command-schema.ts';
import { buildActionDetails } from '../../../daemon/session-event-action.ts';
import { COMMAND_OUTPUT_SCHEMAS } from '../../../mcp/command-output-schemas.ts';
import {
  commandDescriptors,
  commandSupportsSettleObservation,
  commandSupportsVerifyEvidence,
  resolveCommandPostActionObservationSupport,
} from '../registry.ts';

/**
 * The descriptor gate for the `--settle` / `--verify` surfaces (#1652). Every
 * caller-facing surface derives from `postActionObservation`; these tests pin
 * each one to the trait so a forgotten cell fails here instead of silently
 * no-op'ing the flag:
 *
 * | Surface                    | Enforcement                                            |
 * | -------------------------- | ------------------------------------------------------ |
 * | CLI allowed flags          | below (+ timeout policy in timeout-policy.test.ts)     |
 * | Metadata / MCP input fields| below                                                  |
 * | CLI reader input           | below — merged at the `readInputFromCli` seam          |
 * | Client option projections  | below — end to end through `definition.invoke`         |
 * | Contracts option types     | compile error (`post-action-observation-client-options`)|
 * | Session safe-flag specs    | below                                                  |
 * | MCP output schemas         | below — grafted in `command-output-schemas.ts`         |
 * | CLI output formatters      | below — wrapped in `settle-output.ts`                  |
 * | MCP ref-pinning            | derived in `mcp/tool-ref-pins.ts`                      |
 */

const SETTLE_OBSERVATION_COMMANDS = [
  PUBLIC_COMMANDS.click,
  PUBLIC_COMMANDS.fill,
  PUBLIC_COMMANDS.longPress,
  PUBLIC_COMMANDS.hover,
  PUBLIC_COMMANDS.press,
  PUBLIC_COMMANDS.scroll,
  PUBLIC_COMMANDS.back,
] as const;

const SETTLE_FLAGS_SNAPSHOT = {
  settle: true,
  settleQuietMs: 250,
  timeoutMs: 4000,
} as CliFlags;

// Minimal valid positionals per settle-capable reader; coverage against the
// trait set is asserted so a new trait command cannot skip its fixture.
const SETTLE_READER_POSITIONALS: Record<string, string[]> = {
  [PUBLIC_COMMANDS.click]: ['10', '20'],
  [PUBLIC_COMMANDS.press]: ['10', '20'],
  [PUBLIC_COMMANDS.longPress]: ['10', '20'],
  [PUBLIC_COMMANDS.hover]: ['10', '20'],
  [PUBLIC_COMMANDS.fill]: ['10', '20', 'hello'],
  [PUBLIC_COMMANDS.scroll]: ['down'],
  [PUBLIC_COMMANDS.back]: [],
};

test('post-action observation descriptor traits are the source for settle command support', () => {
  const descriptorCommands = commandDescriptors
    .filter(
      (descriptor) => resolveCommandPostActionObservationSupport(descriptor.name) !== undefined,
    )
    .map((descriptor) => descriptor.name)
    .sort();
  assert.deepEqual(descriptorCommands, [...SETTLE_OBSERVATION_COMMANDS].sort());

  assert.equal(resolveCommandPostActionObservationSupport('click'), 'settle-and-verify');
  assert.equal(resolveCommandPostActionObservationSupport('press'), 'settle-and-verify');
  assert.equal(resolveCommandPostActionObservationSupport('fill'), 'settle-and-verify');
  assert.equal(resolveCommandPostActionObservationSupport('longpress'), 'settle');
  assert.equal(commandSupportsVerifyEvidence('longpress'), false);
  // #1783: hover reveals UI instead of activating a target, so the settled
  // diff is the observation and there is no --verify digest.
  assert.equal(resolveCommandPostActionObservationSupport('hover'), 'settle');
  assert.equal(commandSupportsVerifyEvidence('hover'), false);
  // #1638: the generic-route pair resolves no element, so there is nothing to
  // digest into --verify evidence — the settled diff IS the observation.
  assert.equal(resolveCommandPostActionObservationSupport('scroll'), 'settle');
  assert.equal(resolveCommandPostActionObservationSupport('back'), 'settle');
  assert.equal(commandSupportsVerifyEvidence('scroll'), false);
  assert.equal(commandSupportsVerifyEvidence('back'), false);
});

test('post-action observation CLI flags follow descriptor traits', () => {
  for (const command of SETTLE_OBSERVATION_COMMANDS) {
    const schema = getCliCommandSchema(command);
    const allowedFlags = new Set(schema.allowedFlags ?? []);
    assert.equal(allowedFlags.has('settle'), true, `${command}: missing --settle`);
    assert.equal(allowedFlags.has('settleQuietMs'), true, `${command}: missing --settle-quiet`);
    assert.equal(allowedFlags.has('timeoutMs'), true, `${command}: missing settle --timeout`);
    assert.equal(
      allowedFlags.has('verify'),
      commandSupportsVerifyEvidence(command),
      `${command}: verify flag must match descriptor trait`,
    );
  }
});

test('post-action observation metadata fields follow descriptor traits', () => {
  for (const descriptor of commandDescriptors) {
    const metadata = findCommandMetadata(descriptor.name);
    if (!metadata) continue;
    const properties = metadata.inputSchema.properties ?? {};
    assert.equal(
      Object.hasOwn(properties, 'settle'),
      commandSupportsSettleObservation(descriptor.name),
      `${descriptor.name}: settle field must match descriptor trait`,
    );
    assert.equal(
      Object.hasOwn(properties, 'verify'),
      commandSupportsVerifyEvidence(descriptor.name),
      `${descriptor.name}: verify field must match descriptor trait`,
    );
  }
});

test('post-action observation CLI reader input follows descriptor traits', () => {
  assert.deepEqual(
    Object.keys(SETTLE_READER_POSITIONALS).sort(),
    [...SETTLE_OBSERVATION_COMMANDS].sort(),
  );
  for (const [command, positionals] of Object.entries(SETTLE_READER_POSITIONALS)) {
    const input = readInputFromCli(command as CommandName, positionals, SETTLE_FLAGS_SNAPSHOT);
    assert.equal(input.settle, true, `${command}: --settle must reach daemon input`);
    assert.equal(input.settleQuietMs, 250, `${command}: --settle-quiet must reach daemon input`);
    assert.equal(input.timeoutMs, 4000, `${command}: settle --timeout must reach daemon input`);
  }
  // Readers outside the trait must not leak the triple even when raw flags
  // carry it — including `type`, which shares fill's text-entry spec family.
  const nonSettleReaders: Array<[CommandName, string[]]> = [
    [PUBLIC_COMMANDS.home, []],
    [PUBLIC_COMMANDS.type, ['hi']],
    [PUBLIC_COMMANDS.swipe, ['30', '40', '50', '60']],
  ];
  for (const [command, positionals] of nonSettleReaders) {
    const input = readInputFromCli(command, positionals, SETTLE_FLAGS_SNAPSHOT);
    assert.equal('settle' in input, false, `${command}: non-settle reader must ignore --settle`);
    assert.equal(
      'settleQuietMs' in input,
      false,
      `${command}: non-settle reader must ignore --settle-quiet`,
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

test('post-action observation client options follow descriptor traits', async () => {
  const definitions = listCommandFamilyDefinitions();
  for (const [command, positionals] of Object.entries(SETTLE_READER_POSITIONALS)) {
    const definition = definitions.find((entry) => entry.name === command);
    assert.ok(definition, `${command}: missing executable definition`);
    const calls: Array<Record<string, unknown>> = [];
    await definition.invoke(
      recordingClient(calls),
      readInputFromCli(command as CommandName, positionals, SETTLE_FLAGS_SNAPSHOT),
    );
    assert.equal(calls.length, 1, `${command}: expected exactly one client call`);
    assert.equal(calls[0]?.settle, true, `${command}: settle option must survive projection`);
    assert.equal(
      calls[0]?.settleQuietMs,
      250,
      `${command}: settle quiet window must survive projection`,
    );
    assert.equal(calls[0]?.timeoutMs, 4000, `${command}: settle deadline must survive projection`);
  }
});

function actionWithSettleFlags(command: string): SessionAction {
  return {
    ts: 0,
    command,
    positionals: [],
    flags: { settle: true, settleQuietMs: 250 },
    result: {},
  };
}

test('post-action observation session-event safe flags follow descriptor traits', () => {
  for (const command of SETTLE_OBSERVATION_COMMANDS) {
    const details = buildActionDetails(actionWithSettleFlags(command));
    const flags = (details.flags ?? {}) as Record<string, unknown>;
    assert.equal(flags.settle, true, `${command}: session event must disclose settle`);
    assert.equal(
      flags.settleQuietMs,
      250,
      `${command}: session event must disclose the settle quiet window`,
    );
  }
  for (const command of [PUBLIC_COMMANDS.type, PUBLIC_COMMANDS.swipe]) {
    const details = buildActionDetails(actionWithSettleFlags(command));
    const flags = (details.flags ?? {}) as Record<string, unknown>;
    assert.equal(
      'settle' in flags,
      false,
      `${command}: non-settle session event must not disclose settle`,
    );
  }
});

type SchemaView = {
  properties?: Record<string, unknown>;
  oneOf?: readonly SchemaView[];
};

function* settlePropertyGroups(schema: SchemaView): Generator<Record<string, unknown>> {
  for (const branch of schema.oneOf ?? []) yield* settlePropertyGroups(branch);
  if (schema.properties) yield schema.properties;
}

test('post-action observation MCP output schemas follow descriptor traits', () => {
  // The trait denominator must be covered by the schema keys: a settle-capable
  // command with no entry at all (the pre-#1652 scroll gap) is drift too.
  for (const command of SETTLE_OBSERVATION_COMMANDS) {
    assert.ok(
      Object.hasOwn(COMMAND_OUTPUT_SCHEMAS, command),
      `${command}: settle-capable command must have an output schema entry`,
    );
  }
  for (const [command, schema] of Object.entries(COMMAND_OUTPUT_SCHEMAS)) {
    const expected = commandSupportsSettleObservation(command);
    let groups = 0;
    for (const properties of settlePropertyGroups(schema as SchemaView)) {
      groups += 1;
      assert.equal(
        Object.hasOwn(properties, 'settle'),
        expected,
        `${command}: settle advertisement must match descriptor trait`,
      );
    }
    if (expected) {
      assert.ok(groups > 0, `${command}: settle-capable schema must have object groups`);
    }
  }
});

test('post-action observation CLI output formatters follow descriptor traits', () => {
  const formatters = listCommandFamilyCliOutputFormatters();
  for (const command of SETTLE_OBSERVATION_COMMANDS) {
    assert.ok(formatters[command], `${command}: missing CLI output formatter`);
  }
  const settledResult = { message: 'ok', settle: { settled: true, waitedMs: 12 } };
  for (const [command, format] of Object.entries(formatters)) {
    let text: string;
    try {
      text = String(format({ input: {}, result: settledResult }).text ?? '');
    } catch {
      // Formatters expecting a differently-shaped result (device lists) are
      // orthogonal to settle rendering — but a settle-capable formatter must
      // cope with a settled response.
      assert.equal(
        commandSupportsSettleObservation(command),
        false,
        `${command}: settle-capable formatter must render the settled result`,
      );
      continue;
    }
    assert.equal(
      text.includes('settled after'),
      commandSupportsSettleObservation(command),
      `${command}: settle rendering must match descriptor trait`,
    );
  }
});

// The compile-time cells live in post-action-observation-client-options.ts:
// a missing or extra cell, or a dropped `& SettleCommandOptions` intersection,
// fails the build. Pin the declared set to the descriptor trait here so the
// module cannot be gutted without this gate noticing.
const COMPILE_TIME_CLIENT_OPTION_COVERAGE: SettleCapableClientOptionCommands = [
  'click',
  'press',
  'longpress',
  'hover',
  'fill',
  'scroll',
  'back',
];

test('post-action observation contracts option types cover the trait', () => {
  assert.deepEqual(
    [...COMPILE_TIME_CLIENT_OPTION_COVERAGE].sort(),
    [...SETTLE_OBSERVATION_COMMANDS].sort(),
  );
});
