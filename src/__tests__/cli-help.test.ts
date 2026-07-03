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
  assert.match(result.stdout, /agent-device help react-devtools/);
  assert.match(result.stdout, /React Native performance\/profiling/);
  assert.match(result.stdout, /agent-device react-devtools status/);
});

test('help workflow prints agent workflow topic and skips daemon dispatch', async () => {
  const result = await runCliCapture(['help', 'workflow']);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 0);
  assert.match(result.stdout, /agent-device help workflow/);
  assert.match(result.stdout, /Core loop:/);
  assert.match(result.stdout, /Do not use CSS selectors/);
});

test('help workflow preserves known device workaround guidance', async () => {
  const result = await runCliCapture(['help', 'workflow']);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 0);
  assert.match(result.stdout, /disabled\/hittable:false/);
  assert.match(result.stdout, /snapshot -i --json/);
  assert.match(result.stdout, /@Label_Name/);
  assert.match(result.stdout, /press @e12/);
  assert.match(result.stdout, /Snapshot legend:/);
  assert.match(result.stdout, /preview="Leave at side\.\.\." truncated/);
  assert.match(result.stdout, /wait text/);
  assert.match(result.stdout, /Never use args/);
  assert.match(result.stdout, /Never use args, step/);
  assert.match(result.stdout, /scroll bottom\/top/);
  assert.match(result.stdout, /--delay-ms/);
  assert.match(result.stdout, /Discovery is not enough when the task asks to open\/start/);
  assert.match(result.stdout, /If the task says install, use install/);
  assert.match(result.stdout, /do not inspect project files to find one/);
  assert.match(result.stdout, /do not split clear\/restart/);
  assert.match(result.stdout, /do not write network log headers/);
  assert.match(result.stdout, /iOS Allow Paste prompt cannot be exercised under XCUITest/);
  assert.match(result.stdout, /agent-device clipboard write "some text"/);
  assert.match(result.stdout, /provider-native text injection when available/);
  assert.match(result.stdout, /Do not switch to raw adb, clipboard, or paste as an agent fallback/);
  assert.match(result.stdout, /exact key that includes the agent-device package and Xcode version/);
  assert.match(result.stdout, /Avoid broad restore-key fallbacks/);
});

test('help workflow documents the selector disambiguation policy (#1037)', async () => {
  const result = await runCliCapture(['help', 'workflow']);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 0);
  assert.match(result.stdout, /does not fail by default/);
  assert.match(result.stdout, /deepest node first/);
  assert.match(result.stdout, /then smallest on-screen area/);
  assert.match(result.stdout, /Selector did not resolve uniquely/);
  assert.match(result.stdout, /replay and replay-heal apply the same depth-then-area policy/);
  assert.match(result.stdout, /targetHittable: false/);
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
