import { test } from 'vitest';
import assert from 'node:assert/strict';
import { usageForCommand } from '../args.ts';

test('usageForCommand documents open --launch-args', async () => {
  const help = await usageForCommand('open');
  if (help === null) throw new Error('Expected open help text');
  assert.match(help, /--launch-args <arg>/);
  assert.match(help, /forwarded verbatim/);
  assert.match(help, /Linux and macOS reject the flag/);
  assert.match(help, /--launch-console artifacts\/launch-console\.log/);
});

test('usageForCommand documents screenshot web aliases and stabilization flags', async () => {
  const help = await usageForCommand('screenshot');
  if (help === null) throw new Error('Expected screenshot help text');
  assert.match(help, /--fullscreen, --full, -f/);
  assert.match(help, /entire page/i);
  assert.match(help, /--no-stabilize/);
  assert.match(help, /low-latency Android capture loops/);
  assert.match(help, /--normalize-status-bar/);
  assert.match(help, /deterministic iOS simulator chrome/);
});

test('usageForCommand documents screenshot diff normalization', async () => {
  const help = await usageForCommand('diff');
  if (help === null) throw new Error('Expected diff help text');
  assert.match(help, /Live iOS simulator screenshot diffs normalize status-bar chrome by default/);
  assert.match(help, /screenshot --normalize-status-bar/);
});

test('usageForCommand resolves longpress help', async () => {
  const help = await usageForCommand('longpress');
  assert.equal(help === null, false);
  assert.match(help ?? '', /agent-device longpress <x y\|@ref\|selector> \[durationMs\]/);
});

test('usageForCommand documents tv-remote longpress preset', async () => {
  const help = await usageForCommand('tv-remote');
  assert.equal(help === null, false);
  assert.match(help ?? '', /agent-device tv-remote \[press\|longpress\]/);
  assert.match(help ?? '', /--duration-ms <ms>/);
  assert.match(help ?? '', /Use longpress for a 500ms held remote button/);
});

test('usageForCommand supports legacy long-press alias', async () => {
  const help = await usageForCommand('long-press');
  assert.equal(help === null, false);
  assert.match(help ?? '', /agent-device longpress <x y\|@ref\|selector> \[durationMs\]/);
  assert.doesNotMatch(help ?? '', /agent-device long-press/);
});

test('usageForCommand supports tap alias for press', async () => {
  const help = await usageForCommand('tap');
  assert.equal(help === null, false);
  assert.match(help ?? '', /agent-device press/);
  assert.doesNotMatch(help ?? '', /agent-device tap/);
});

test('usageForCommand documents keyboard dismissal flow', async () => {
  const help = await usageForCommand('keyboard');
  assert.equal(help === null, false);
  assert.match(help ?? '', /To hide the keyboard, use keyboard dismiss/);
  assert.match(help ?? '', /taps safe controls like Done/);
  assert.match(help ?? '', /UNSUPPORTED_OPERATION/);
});

test('usageForCommand supports metrics alias', async () => {
  const help = await usageForCommand('metrics');
  assert.equal(help === null, false);
  assert.match(help ?? '', /agent-device perf/);
  assert.match(help ?? '', /report --kind xctrace --out <report\.json>/);
  assert.match(help ?? '', /profile report --kind simpleperf --out <cpu-report\.json>/);
  assert.match(help ?? '', /report writes a compact \.json summary/);
  assert.match(help ?? '', /Native perf output is agent evidence/);
  assert.match(help ?? '', /raw profiles\/traces stay on disk/);
});

test('usageForCommand includes Maestro replay flag', async () => {
  const help = await usageForCommand('replay');
  if (help === null) throw new Error('Expected replay help text');
  assert.match(help, /replay <path> \| replay export <file\.ad>/);
  assert.match(help, /--format maestro/);
  assert.match(help, /--out <path>/);
  assert.match(help, /--maestro/);
  assert.match(help, /doubleTapOn/);
  assert.match(help, /pasteText/);
  assert.match(help, /runFlow file\/inline/);
  assert.match(help, /ordered trusted runScript/);
  assert.match(help, /repeat\.times/);
  assert.match(help, /stopApp/);
  assert.match(help, /Unsupported syntax fails loudly/);
  assert.match(help, /issues\/558/);
});

test('usageForCommand includes Maestro test suite flag', async () => {
  const help = await usageForCommand('test');
  if (help === null) throw new Error('Expected test help text');
  assert.match(help, /Run one or more replay scripts as a serial test suite/);
  assert.match(help, /--maestro/);
  assert.match(help, /--record-video/);
  assert.match(help, /--shard-all <n>/);
  assert.match(help, /combine with --device id1,id2/);
  assert.match(help, /--shard-split <n>/);
  assert.match(help, /AD_SHARD_INDEX is zero-based/);
  assert.match(help, /Replay\/Test: inject or override/);
});

test('command help keeps scroll and gesture planning guidance', async () => {
  const scrollHelp = await usageForCommand('scroll');
  if (scrollHelp === null) throw new Error('Expected scroll help text');
  assert.match(scrollHelp, /Scroll in a direction/);
  assert.match(scrollHelp, /top\/bottom edge/);

  const gestureHelp = await usageForCommand('gesture');
  if (gestureHelp === null) throw new Error('Expected gesture help text');
  assert.match(gestureHelp, /Android transform verification should use all app-observable effects/);
  assert.match(gestureHelp, /wait text "pan changed yes"/);
});

test('usageForCommand documents prepare ios-runner', async () => {
  const help = await usageForCommand('prepare');
  if (help === null) throw new Error('Expected prepare help text');
  assert.match(help, /Usage:\s+agent-device prepare ios-runner --platform ios\|macos/);
  assert.match(help, /Prepare platform helper infrastructure/);
  assert.match(help, /--timeout <ms>/);
  assert.match(help, /XCTest runner/);
  assert.match(help, /top-level buildMs\/connectMs\/healthCheckMs are diagnostic fields/);
  assert.match(help, /timing\.additiveParts/);
  assert.match(help, /separate daemon/);
  assert.match(help, /stop the prepare daemon before replay\/test/);
  assert.doesNotMatch(help, /clean:daemon|pnpm/);
  assert.match(
    help,
    /not a recovery step for "runner already owned by another agent-device daemon"/,
  );
  assert.match(help, /Runner build\/start output is written to the session runner\.log/);
});

test('workflow help keeps common copyable command forms', async () => {
  const help = await usageForCommand('workflow');
  if (help === null) throw new Error('Expected workflow help text');
  assert.match(help, /network dump --include headers/);
  assert.match(help, /settings animations off/);
  assert.match(help, /connect --remote-config/);
  assert.match(help, /metro reload/);
  assert.match(help, /screenshot --overlay-refs/);
  assert.match(help, /snapshot -s @e7/);
  assert.match(help, /clipboard write "some text"/);
});

test('debug command help stays scoped to symbolication', async () => {
  const help = await usageForCommand('debug');
  if (help === null) throw new Error('Expected debug help text');
  assert.match(help, /debug symbols --artifact/);
  assert.match(help, /intentionally narrow/);
  assert.match(help, /use logs for app logs, network for HTTP evidence, perf for performance/);
  assert.doesNotMatch(help, /agent-device debug perf/);
  assert.doesNotMatch(help, /agent-device debug logs/);
});

test('proxy command help describes tunnel usage', async () => {
  const help = await usageForCommand('proxy');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /Usage:\s+agent-device proxy/);
  assert.match(help, /cloudflared tunnel --url http:\/\/127\.0\.0\.1:4310/);
  assert.match(help, /--host <host>\s+Proxy: host interface to bind/);
  assert.match(help, /--port <port>\s+Proxy: TCP port to bind/);
  assert.match(help, /--daemon-auth-token <token>\s+Remote HTTP daemon or proxy auth token/);
  assert.match(help, /--state-dir <path>\s+Daemon state directory/);
  assert.match(help, /\/agent-device\/\*/);
  assert.match(help, /https:\/\/example\.trycloudflare\.com\/agent-device/);
  assert.match(help, /does not use agent-device auth/);
  assert.doesNotMatch(help, /agent-device-proxy/);
});

test('connect command help lists lease id in usage and flags', async () => {
  const help = await usageForCommand('connect');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /Usage:\s+agent-device connect .*--daemon-base-url <url>/);
  assert.match(help, /--daemon-base-url <url>\s+Explicit remote HTTP daemon base URL/);
  assert.match(help, /Usage:\s+agent-device connect .*--lease-id <id>/);
  assert.match(help, /--lease-id <id>\s+Lease identifier bound to tenant\/run admission scope/);
  assert.doesNotMatch(help, /--project-root <path>/);
  assert.doesNotMatch(help, /--public-base-url <url>/);
  assert.doesNotMatch(help, /--launch-url <url>/);
});

test('install-from-source command help describes all source types', async () => {
  const help = await usageForCommand('install-from-source');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /Install app builds from URLs, remote source specs, or CI artifacts/);
});

test('session command help includes daemon state directory discovery', async () => {
  const help = await usageForCommand('session');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /Usage:\s+agent-device session list \| session state-dir/);
  assert.match(help, /effective daemon state directory/);
});

test('web command help includes managed backend setup', async () => {
  const help = await usageForCommand('web');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /agent-device help web/);
  assert.match(help, /managed, pinned agent-browser backend/);
  assert.match(
    help,
    /agent-device web setup[\s\S]*agent-device open https:\/\/example\.com --platform web/,
  );
  assert.match(help, /Before first use, set up and verify the managed backend/);
  assert.doesNotMatch(help, /do not install the backend implicitly/);
  assert.doesNotMatch(help, /web status/);
});

test('command usage describes test suite flags', async () => {
  const help = await usageForCommand('test');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /Usage:\s+agent-device test <path-or-glob>\.\.\./);
  assert.match(help, /Run one or more replay scripts as a serial test suite/);
  assert.match(help, /--maestro/);
  assert.match(help, /--fail-fast/);
  assert.match(help, /each shard stops independently/);
  assert.match(help, /--timeout <ms>/);
  assert.match(help, /--retries <n>/);
  assert.match(help, /--record-video/);
  assert.match(help, /--artifacts-dir <path>/);
  assert.match(help, /--reporter <name-or-path>/);
  assert.match(help, /custom reporter path/);
  assert.match(help, /--report-junit <path>/);
  assert.match(help, /compatibility alias for --reporter junit:<path>/);
  assert.doesNotMatch(help, /test --verbose prints per-test step timings without debug logs/);
});

test('command usage describes delayed typing flags', async () => {
  const typeHelp = await usageForCommand('type');
  const fillHelp = await usageForCommand('fill');
  if (typeHelp === null || fillHelp === null) {
    throw new Error('Expected command help text');
  }
  assert.match(typeHelp, /--delay-ms <ms>/);
  assert.match(fillHelp, /--delay-ms <ms>/);
});

test('snapshot command usage documents diff alias', async () => {
  const help = await usageForCommand('snapshot');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /agent-device snapshot \[--diff\]/);
  assert.match(help, /--timeout <ms>/);
  assert.match(help, /Capture accessibility tree or diff against the previous session baseline/);
  assert.match(help, /inspect rects with snapshot -i --json/);
  assert.match(help, /verify with diff snapshot -i or snapshot --diff/);
});

test('network command usage documents include flag', async () => {
  const help = await usageForCommand('network');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /--include summary\|headers\|body\|all/);
});

test('command usage shows command flags without global flags', async () => {
  const help = await usageForCommand('swipe');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /Quick coordinate fling with optional repeat pattern/);
  assert.match(help, /duration positional is accepted as a deprecated alias to pan/);
  assert.match(help, /Command flags:/);
  assert.match(help, /--pattern one-way\|ping-pong/);
  assert.doesNotMatch(help, /Global flags:/);
  assert.doesNotMatch(help, /Global Flags:/);
  assert.doesNotMatch(help, /--platform ios\|macos\|android\|linux\|web\|apple/);
});

test('back command usage documents explicit mode flags', async () => {
  const help = await usageForCommand('back');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /agent-device back \[--in-app\|--system\]/);
  assert.match(help, /--in-app/);
  assert.match(help, /--system/);
});

test('open command usage documents surface and console log flags', async () => {
  const help = await usageForCommand('open');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /--surface app\|frontmost-app\|desktop\|menubar/);
  assert.match(help, /macOS also supports --surface/);
  assert.match(help, /--launch-console <path>/);
  assert.match(help, /iOS simulator launch console/);
  assert.match(help, /--device-hub/);
  assert.match(help, /use Xcode Device Hub/);
  assert.match(help, /Use --platform to bind URL\/deep-link opens/);
  assert.match(help, /agent-device open "Expo Go" exp:\/\/127\.0\.0\.1:8081 --platform ios/);
});

test('replay command usage keeps Maestro target binding guidance', async () => {
  const help = await usageForCommand('replay');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /For Maestro YAML compatibility flows/);
  assert.match(help, /replay <flow\.yaml> --maestro/);
  assert.match(help, /--platform ios/);
});

test('command usage shows record touch-overlay opt-out flag', async () => {
  const help = await usageForCommand('record');
  if (help === null) throw new Error('Expected command help text');
  assert.match(
    help,
    /record start \[path\] \[--scope <app\|device\|system>\] \[--fps <n>\] \[--max-size <px>\] \[--quality <medium\|high>\] \[--hide-touches\] \| record stop/,
  );
  assert.match(help, /--scope <app\|device\|system>/);
  assert.match(help, /--max-size <px>/);
  assert.match(help, /--quality <medium\|high>/);
  assert.match(help, /--hide-touches/);
  assert.match(help, /skip touch-overlay post-processing/);
  assert.match(help, /multiple MP4 chunks/);
});

test('command usage keeps detailed descriptions', async () => {
  const help = await usageForCommand('metro');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /Prepare a local React Native dev-server runtime/);
  assert.match(help, /metro reload/);
  assert.match(help, /--metro-host <host>/);
  assert.match(help, /AGENT_DEVICE_METRO_BEARER_TOKEN/);
});

test('metro command usage documents session-hint reload priority, expo bundle kind, and PM detection', async () => {
  const help = await usageForCommand('metro');
  if (help === null) throw new Error('Expected metro help text');
  assert.match(help, /resolves against the dev server/);
  assert.match(help, /never silently reload[s]? a different project/);
  assert.match(help, /cleared when the session closes/);
  assert.match(help, /\.expo\/\.virtual-metro-entry\.bundle/);
  assert.match(help, /yarn\.lock\/pnpm-lock\.yaml\/bun\.lock\/bun\.lockb\/package-lock\.json/);
  assert.match(help, /--no-install-deps/);
});

test('open command usage documents metro session-hint setter flags', async () => {
  const help = await usageForCommand('open');
  if (help === null) throw new Error('Expected open help text');
  assert.match(help, /--metro-host <host>/);
  assert.match(help, /--metro-port <port>/);
  assert.match(help, /--bundle-url <url>/);
  assert.match(help, /--launch-url <url>/);
  assert.match(help, /before its first reload/);
  assert.match(help, /plain metro reload in the same session reuses/);
  assert.match(help, /clears any leftover binding/);
});

test('command usage shows no command flags when unsupported', async () => {
  const help = await usageForCommand('appstate');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /Show foreground app\/activity/);
  assert.doesNotMatch(help, /Command flags:/);
  assert.doesNotMatch(help, /Global flags:/);
  assert.doesNotMatch(help, /Global Flags:/);
});

test('clipboard command usage is documented', async () => {
  const help = await usageForCommand('clipboard');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /clipboard read \| clipboard write <text>/);
  assert.match(help, /Read or write device clipboard text/);
});

test('keyboard command usage is documented', async () => {
  const help = await usageForCommand('keyboard');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /keyboard \[status\|get\|dismiss\|enter\|return\]/);
  assert.match(
    help,
    /Inspect Android keyboard visibility\/type or press\/dismiss the device keyboard/,
  );
});

test('orientation command usage is documented', async () => {
  const help = await usageForCommand('orientation');
  if (help === null) throw new Error('Expected command help text');
  assert.match(
    help,
    /orientation <portrait\|portrait-upside-down\|landscape-left\|landscape-right>/,
  );
  assert.match(help, /Set device orientation on iOS and Android/);
});

test('deprecated rotate alias resolves to orientation usage', async () => {
  const help = await usageForCommand('rotate');
  if (help === null) throw new Error('Expected command help text');
  assert.match(
    help,
    /orientation <portrait\|portrait-upside-down\|landscape-left\|landscape-right>/,
  );
});

test('settings usage documents canonical faceid states', async () => {
  const help = await usageForCommand('settings');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /location set <lat> <lon>/);
  assert.match(help, /clear-app-state \[app-id\]/);
  assert.match(help, /light\|dark\|toggle/);
  assert.match(help, /match\|nonmatch\|enroll\|unenroll/);
  assert.match(
    help,
    /camera\|microphone\|photos\|contacts\|contacts-limited\|notifications\|calendar\|location\|location-always\|media-library\|motion\|reminders\|siri/,
  );
  assert.doesNotMatch(help, /validate\|unvalidate/);
});

test('removed trigger aliases are no longer documented as commands', async () => {
  const help = await usageForCommand('trigger-screenshot-notification');
  assert.equal(help, null);
});
