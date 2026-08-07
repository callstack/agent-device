import { test } from 'vitest';
import assert from 'node:assert/strict';
import { runCliCapture } from './cli-capture.ts';

test('help appstate prints command help and skips daemon dispatch', async () => {
  const result = await runCliCapture(['help', 'appstate']);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 0);
  assert.match(result.stdout, /Show foreground app\/activity/);
  assert.doesNotMatch(result.stdout, /Command flags:/);
  assert.doesNotMatch(result.stdout, /Global flags:/);
  assert.doesNotMatch(result.stdout, /Global Flags:/);
});

test('help longpress prints command help and skips daemon dispatch', async () => {
  const result = await runCliCapture(['help', 'longpress']);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 0);
  assert.match(
    result.stdout,
    /Usage:\n  agent-device longpress <x y\|@ref\|selector> \[durationMs\]/,
  );
});

test('help long-press resolves to longpress help and skips daemon dispatch', async () => {
  const result = await runCliCapture(['help', 'long-press']);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 0);
  assert.match(
    result.stdout,
    /Usage:\n  agent-device longpress <x y\|@ref\|selector> \[durationMs\]/,
  );
  assert.doesNotMatch(result.stdout, /agent-device long-press/);
});

test('appstate --help prints command help and skips daemon dispatch', async () => {
  const result = await runCliCapture(['appstate', '--help']);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 0);
  assert.match(result.stdout, /Usage:\n  agent-device appstate/);
  assert.doesNotMatch(result.stdout, /Global flags:/);
  assert.doesNotMatch(result.stdout, /Global Flags:/);
});

test('prepare help documents iOS runner CI setup', async () => {
  const result = await runCliCapture(['help', 'prepare']);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 0);
  assert.match(result.stdout, /prepare ios-runner --platform ios\|macos/);
  assert.match(result.stdout, /health-checks the XCTest runner/);
  assert.match(result.stdout, /after boot\/install and before replay\/test/);
});

test('connect help documents cloud auth environment origins', async () => {
  const result = await runCliCapture(['help', 'connect']);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 0);
  assert.match(result.stdout, /AGENT_DEVICE_CLOUD_BASE_URL/);
  assert.match(result.stdout, /bridge\/control-plane API origin/);
  assert.match(result.stdout, /AGENT_DEVICE_DAEMON_AUTH_TOKEN/);
});

test('help react-devtools prints agent workflow topic and skips daemon dispatch', async () => {
  const result = await runCliCapture(['help', 'react-devtools']);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 0);
  assert.match(result.stdout, /^agent-device \S+ — react-devtools/);
  assert.match(result.stdout, /React Native performance\/profiling/);
  assert.match(result.stdout, /agent-device react-devtools status/);
});

test('help workflow prints the compact workflow card with a version header and skips daemon dispatch', async () => {
  const result = await runCliCapture(['help', 'workflow']);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 0);
  assert.match(result.stdout, /^agent-device \S+ — workflow/);
  assert.ok(
    Buffer.byteLength(result.stdout, 'utf8') < 9000,
    `help workflow should stay close to the compact-card size target, was ${Buffer.byteLength(result.stdout, 'utf8')} bytes`,
  );
  assert.match(result.stdout, /open -> snapshot -i -> settle -> verify -> close loop/);
  assert.match(result.stdout, /no CSS selectors/);
  assert.match(result.stdout, /help scripting/);
  assert.match(result.stdout, /help gestures/);
});

test('help workflow encourages chaining confident steps and requires the end state to be on screen', async () => {
  const result = await runCliCapture(['help', 'workflow']);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 0);
  assert.match(result.stdout, /Chain confident consecutive steps with &&/);
  assert.match(result.stdout, /Fall back to one command at a time when a step is uncertain/);
  assert.match(
    result.stdout,
    /confirm the requested end state is actually visible on the current screen, scrolling it into view if needed/,
  );
  assert.match(result.stdout, /get text alone, or stopping one screen early, is not enough/);
});

test('help workflow preserves known device workaround guidance', async () => {
  const result = await runCliCapture(['help', 'workflow']);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 0);
  assert.match(result.stdout, /snapshot -i/);
  assert.match(result.stdout, /@Label_Name/);
  assert.match(result.stdout, /press @e12/);
  assert.match(result.stdout, /Legend:/);
  assert.match(result.stdout, /--delay-ms/);
  assert.match(result.stdout, /Never open artifact paths or invent package ids/);
  assert.match(
    result.stdout,
    /iOS paste-prompt limits and Android IME\/handwriting capture quirks/,
  );
});

test('help workflow documents the selector disambiguation policy (#1037)', async () => {
  const result = await runCliCapture(['help', 'workflow']);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 0);
  assert.match(result.stdout, /collapse duplicate accessibility wrappers only when/);
  assert.match(result.stdout, /one ancestor-descendant chain/);
  assert.match(result.stdout, /Matches in distinct subtrees fail with AMBIGUOUS_MATCH/);
  assert.match(result.stdout, /geometry never chooses a winner/);
  assert.match(result.stdout, /Retry one printed candidate ref/);
  assert.match(result.stdout, /targetHittable: false/);
});

test('help workflow documents open/close/relaunch runner guarantees as lifecycle facts (#1051)', async () => {
  const result = await runCliCapture(['help', 'workflow']);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 0);
  assert.match(result.stdout, /Lifecycle facts \(trust these instead of probing\)/);
  assert.match(result.stdout, /idempotent-foreground/);
  assert.match(result.stdout, /already owned by another agent-device daemon/);
  assert.match(result.stdout, /Env vars: help physical-device/);
});

test('help physical-device documents the runner/daemon lifecycle detail moved out of workflow (#1051)', async () => {
  const result = await runCliCapture(['help', 'physical-device']);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 0);
  assert.match(
    result.stdout,
    /one simctl launch --terminate-running-process call instead of a separate terminate-then-launch/,
  );
  assert.match(
    result.stdout,
    /keeps a healthy iOS simulator XCTest runner warm by default so the next open on that device skips the runner build/,
  );
  assert.match(result.stdout, /the session held a device lease/);
  assert.match(result.stdout, /AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS/);
  assert.match(
    result.stdout,
    /self-exits after an idle window \(default 5 minutes, matching the runner idle-stop default\)/,
  );
  assert.match(result.stdout, /AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS/);
  assert.match(
    result.stdout,
    /a stale iOS runner lease — its owner process dead, or its AGENT_DEVICE_STATE_DIR deleted — is reclaimed automatically/i,
  );
  assert.match(result.stdout, /genuinely live owner whose state dir still exists still rejects/);
});

test('help workflow documents ref lifetime and snapshot diff guarantees (#1051)', async () => {
  const result = await runCliCapture(['help', 'workflow']);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 0);
  assert.match(result.stdout, /open\/--relaunch clears the stored snapshot outright/);
  assert.match(result.stdout, /initializes the baseline \(zero changes\) instead of failing/);
});

test('help scripting documents replay divergence/resume and wait polling guarantees (#1051)', async () => {
  const result = await runCliCapture(['help', 'scripting']);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 0);
  assert.match(result.stdout, /REPLAY_DIVERGENCE with a bounded report/);
  assert.match(result.stdout, /replay --from <n> --plan-digest <sha256>/);
  assert.match(result.stdout, /resume never re-executes skipped steps/);
});

test('help gestures prints the multi-touch topic and skips daemon dispatch', async () => {
  const result = await runCliCapture(['help', 'gestures']);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 0);
  assert.match(result.stdout, /^agent-device \S+ — gestures/);
  assert.match(result.stdout, /agent-device gesture transform 200 420 80 -40 2 35 700/);
});

test('help unknown command prints error plus global usage and skips daemon dispatch', async () => {
  const result = await runCliCapture(['help', 'not-a-command']);
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 0);
  assert.match(result.stderr, /Error \(INVALID_ARGS\): Unknown command: not-a-command/);
  assert.match(result.stdout, /Commands:/);
  assert.match(result.stdout, /Global Flags:/);
  assert.match(result.stdout, /--config <path>/);
});

test('unknown command --help prints error plus global usage and skips daemon dispatch', async () => {
  const result = await runCliCapture(['not-a-command', '--help']);
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 0);
  assert.match(result.stderr, /Error \(INVALID_ARGS\): Unknown command: not-a-command/);
  assert.match(result.stdout, /Commands:/);
});

test('runtime command is rejected before daemon dispatch', async () => {
  const result = await runCliCapture(['runtime', 'show']);
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 0);
  assert.match(result.stderr, /Error \(INVALID_ARGS\): runtime command was removed/);
});

test('help rejects multiple positional commands and skips daemon dispatch', async () => {
  const result = await runCliCapture(['help', 'appstate', 'extra']);
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 0);
  assert.match(result.stderr, /Error \(INVALID_ARGS\): help accepts at most one command/);
});

test('tap dispatches as press with positionals and flags preserved', async () => {
  const result = await runCliCapture(['tap', '@e3', '--json']);
  assert.doesNotMatch(result.stderr, /Unknown command/);
  // Canonicalization: the daemon call must record press, never tap.
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.command, 'press');
  assert.deepEqual(result.calls[0]?.positionals, ['@e3']);
});

test('relaunch dispatches as open with the relaunch flag injected', async () => {
  const result = await runCliCapture(['relaunch', 'com.example.app', '--json']);
  assert.doesNotMatch(result.stderr, /Unknown command/);
  // Canonicalization: the daemon call must record open, never relaunch.
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.command, 'open');
  assert.deepEqual(result.calls[0]?.positionals, ['com.example.app']);
  assert.equal(result.calls[0]?.flags?.relaunch, true);
});

test('launch dispatches as a plain open without forcing a relaunch', async () => {
  const result = await runCliCapture(['launch', 'com.example.app', '--json']);
  assert.doesNotMatch(result.stderr, /Unknown command/);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.command, 'open');
  assert.deepEqual(result.calls[0]?.positionals, ['com.example.app']);
  assert.notEqual(result.calls[0]?.flags?.relaunch, true);
});

test('rotate fails with a migration message pointing to orientation', async () => {
  const result = await runCliCapture(['rotate', 'landscape-left']);
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 0);
  assert.match(result.stderr, /rotate was renamed to orientation/);
});

// From #1052 (credit: @vku2018): the alias must compose with the bare-ref
// hint — `tap e3` normalizes to press, then gets the @e3 suggestion.
test('tap with a bare ref gets the @ref hint, not an unknown-command error', async () => {
  const result = await runCliCapture(['tap', 'e3', '--session', 'foo']);
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 0);
  assert.match(result.stderr, /Did you mean "@e3"\?/);
  assert.doesNotMatch(result.stderr, /Unknown command: tap/);
});

// Regression coverage for #1036 (moved off `tap` when it became an alias):
// unknown commands must be reported before per-command flag validation.
test('unknown command with flags reports unknown command before flag validation', async () => {
  const result = await runCliCapture(['bogus-cmd', 'e3', '--session', 'foo']);
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 0);
  assert.match(result.stderr, /Error \(INVALID_ARGS\): Unknown command: bogus-cmd/);
  assert.doesNotMatch(result.stderr, /not supported for command/);
});

test('unknown command without flags reports unknown command', async () => {
  const result = await runCliCapture(['bogus-cmd', 'e3']);
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 0);
  assert.match(result.stderr, /Error \(INVALID_ARGS\): Unknown command: bogus-cmd/);
});
