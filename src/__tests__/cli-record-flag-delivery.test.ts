/**
 * `--no-record` / `--record` delivery, asserted at the DAEMON REQUEST — the
 * layer that is actually observable.
 *
 * #1304/#1305 asserted on `readInputFromCli` output instead, and shipped green
 * while the flag was inert: the reader's object is an intermediate that two
 * later layers rebuild from scratch. `readFieldInput` keeps only declared
 * metadata fields plus `readCommonInput`'s output, and each `to*Options`
 * projection rebuilds the client options from `commonToClientOptions` plus its
 * own named fields. A flag dropped at either one never reaches the daemon, so
 * an assertion upstream of both cannot see the bug it is meant to catch.
 *
 * These tests therefore drive the REAL chain a user's argv takes —
 * parseArgs -> readInputFromCli -> runCommand -> client -> transport — and
 * assert on the daemon request's flags.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createAgentDeviceClient } from '../agent-device-client.ts';
import type { AgentDeviceClient } from '../client/client-types.ts';
import { parseArgs } from '../cli/parser/args.ts';
import { runCliCommandWithOutput } from '../commands/cli-runner.ts';
import type { CommandName } from '../commands/command-metadata.ts';

type SeenRequest = { command: string; noRecord?: boolean; record?: boolean };

/** Runs a full argv line and returns the daemon requests it produced. */
async function runArgv(argv: string[]): Promise<SeenRequest[]> {
  const seen: SeenRequest[] = [];
  const client: AgentDeviceClient = createAgentDeviceClient(
    {},
    {
      transport: async (req) => {
        seen.push({
          command: req.command,
          noRecord: req.flags?.noRecord === true ? true : undefined,
          record: req.flags?.record === true ? true : undefined,
        });
        return { ok: true, data: {} } as never;
      },
    },
  );
  const parsed = parseArgs(argv, { strictFlags: true });
  try {
    await runCliCommandWithOutput({
      client,
      command: argv[0] as CommandName,
      positionals: parsed.positionals,
      flags: parsed.flags,
    });
  } catch {
    // Result normalizers reject the stub's empty payload for some commands; the
    // request was already captured by then, which is all these tests assert on.
  }
  return seen;
}

// Every recordable route, including the ones #1305 hand-listed (which were inert
// end-to-end) and the ones it missed entirely (gesture/back/home + the generic
// and session routes). Positionals are the minimum each reader parses.
const RECORDABLE_ARGV: Array<[CommandName, string[]]> = [
  ['press', ['press', '10', '20']],
  ['click', ['click', '10', '20']],
  ['fill', ['fill', 'id=email', 'qa@example.com']],
  ['longpress', ['longpress', '10', '20']],
  ['swipe', ['swipe', '0', '0', '10', '10']],
  ['focus', ['focus', '10', '20']],
  ['type', ['type', 'hello']],
  ['scroll', ['scroll', 'down']],
  ['get', ['get', 'attrs', '@e5']],
  ['is', ['is', 'visible', 'id=title']],
  ['find', ['find', 'label', 'Continue', 'exists']],
  ['snapshot', ['snapshot']],
  ['wait', ['wait', 'Continue']],
  // Missed by #1305 entirely:
  ['gesture', ['gesture', 'fling', 'up', '100', '200']],
  ['back', ['back']],
  ['home', ['home']],
  ['app-switcher', ['app-switcher']],
  ['orientation', ['orientation', 'landscape-left']],
  ['keyboard', ['keyboard', 'dismiss']],
  ['clipboard', ['clipboard', 'read']],
  ['tv-remote', ['tv-remote', 'select']],
  ['alert', ['alert', 'accept']],
  ['settings', ['settings', 'wifi', 'on']],
  ['screenshot', ['screenshot']],
  ['viewport', ['viewport', '100', '200']],
  ['open', ['open', 'App']],
  ['push', ['push', '/a', '/b']],
  ['trigger-app-event', ['trigger-app-event', 'evt']],
  ['record', ['record', 'start']],
  ['trace', ['trace', 'start', '/tmp/t.log']],
  ['perf', ['perf', 'metrics']],
  ['react-native', ['react-native', 'dismiss-overlay']],
];

test('--no-record reaches the daemon request for every recordable command', async () => {
  for (const [command, argv] of RECORDABLE_ARGV) {
    const seen = await runArgv([...argv, '--no-record']);
    assert.ok(seen.length > 0, `${command} produced no daemon request`);
    assert.ok(
      seen.some((req) => req.noRecord === true),
      `${command} accepted --no-record but never delivered it to the daemon`,
    );
  }
});

test('--no-record is absent from the daemon request when the flag is not passed', async () => {
  const seen = await runArgv(['press', '10', '20']);
  assert.equal(seen[0]?.noRecord, undefined);
});

// The deliberate asymmetry (ADR 0012 decision 6 amendment): --no-record applies
// to every recordable command and rides the common seam; --record is scoped to
// the observation-only commands the repair-segment exclusion can drop, so it
// must NOT become common as a side effect of the --no-record seam fix.
test('--record reaches the daemon only for the observation-only commands that accept it', async () => {
  for (const argv of [
    ['get', 'attrs', '@e5'],
    ['is', 'visible', 'id=title'],
    ['snapshot'],
    ['find', 'label', 'Continue', 'exists'],
  ]) {
    const seen = await runArgv([...argv, '--record']);
    assert.ok(
      seen.some((req) => req.record === true),
      `${argv[0]} accepted --record but never delivered it to the daemon`,
    );
  }
});

test('--record stays scoped: the CLI rejects it on a mutating command', () => {
  // Grammar-level refusal, before projection: `record` is not in press's
  // allowedFlags, so it must not parse as a silently-ignored flag.
  assert.throws(
    () => parseArgs(['press', '10', '20', '--record'], { strictFlags: true }),
    /--record/,
  );
});
