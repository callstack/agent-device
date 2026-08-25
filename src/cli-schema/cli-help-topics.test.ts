import { test } from 'vitest';
import assert from 'node:assert/strict';
import { usage, usageForCommand } from '../cli/parser/args.ts';

test('commands topic includes concise command catalog entries', async () => {
  const usageText = await usageForCommand('commands');
  if (usageText === null) throw new Error('Expected commands help text');
  assert.match(usageText, /install-from-source\s{2,}Install app builds from URLs or CI artifacts/);
  assert.match(usageText, /prepare\s{2,}Pre-warm platform helpers before automation/);
  assert.match(usageText, /metro\s{2,}Prepare the dev server or reload apps/);
  assert.match(usageText, /batch --steps <json> \| --steps-file <path>/);
  assert.match(usageText, /network\s{2,}Inspect HTTP\(S\) traffic from session logs/);
  assert.match(usageText, /clipboard read \| clipboard write <text>/);
  assert.match(usageText, /keyboard \[action\]/);
  assert.match(usageText, /trigger-app-event\s{2,}Invoke an app-defined automation event/);
  assert.match(usageText, /gesture <pan\|fling\|swipe\|pinch\|rotate\|transform\|drag> \.\.\./);
  assert.doesNotMatch(
    usageText,
    /install-from-source <url> \| install-from-source --github-actions-artifact/,
  );
  assert.doesNotMatch(usageText, /prepare ios-runner --platform ios\|macos/);
  assert.doesNotMatch(usageText, /metro prepare --public-base-url <url>/);
  assert.doesNotMatch(usageText, /^  network dump/m);
  assert.doesNotMatch(usageText, /trigger-app-event <event> \[payloadJson\]/);
  assert.doesNotMatch(usageText, /^  pan <x> <y> <dx> <dy> \[durationMs\]/m);
  assert.doesNotMatch(usageText, /^  fling <up\|down\|left\|right>/m);
  assert.doesNotMatch(usageText, /^  pinch <scale> \[x\] \[y\]/m);
  assert.doesNotMatch(usageText, /^  rotate-gesture <degrees>/m);
  assert.match(usageText, /orientation <orientation>/);
  assert.match(usageText, /record start \[path\] \| record stop/);
  assert.match(usageText, /trace start <path> \| trace stop <path>/);
});

test('gesture help documents selectors and pinned refs for both drag endpoints', async () => {
  const help = await usageForCommand('gesture');
  assert.ok(help);
  assert.match(help, /drag <source-selector\|pinned-ref> <destination-selector\|pinned-ref>/);
});

test('commands topic includes only global flags in its global flags section', async () => {
  const usageText = await usageForCommand('commands');
  if (usageText === null) throw new Error('Expected commands help text');
  const flagsSection = usageText.slice(
    usageText.indexOf('Global Flags:'),
    usageText.indexOf('Configuration:'),
  );
  assert.match(flagsSection, /^Global Flags:/);
  assert.match(flagsSection, /--config <path>/);
  assert.match(flagsSection, /--json/);
  assert.match(flagsSection, /--help, -h/);
  assert.match(flagsSection, /--version, -V/);
  assert.match(flagsSection, /test --verbose prints per-test step timings without debug logs/);
  assert.doesNotMatch(flagsSection, /--target mobile\|tv/);
  assert.doesNotMatch(flagsSection, /--ios-simulator-device-set <path>/);
  assert.doesNotMatch(flagsSection, /--android-device-allowlist <serials>/);
  assert.doesNotMatch(flagsSection, /--state-dir <path>/);
  assert.doesNotMatch(flagsSection, /--daemon-transport auto\|socket\|http/);
  assert.doesNotMatch(flagsSection, /--daemon-server-mode socket\|http\|dual/);
  assert.doesNotMatch(flagsSection, /--tenant <id>/);
  assert.doesNotMatch(flagsSection, /--session-isolation none\|tenant/);
  assert.doesNotMatch(flagsSection, /--run-id <id>/);
  assert.doesNotMatch(flagsSection, /--lease-id <id>/);
  assert.doesNotMatch(
    flagsSection,
    /--lease-backend ios-simulator\|ios-instance\|android-instance/,
  );
  assert.doesNotMatch(flagsSection, /--relaunch/);
  assert.doesNotMatch(flagsSection, /--header <name:value>/);
  assert.doesNotMatch(flagsSection, /--restart/);
  assert.doesNotMatch(flagsSection, /--fps <n>/);
  assert.doesNotMatch(flagsSection, /--quality <medium\|high>/);
  assert.doesNotMatch(flagsSection, /--save-script \[path\]/);
  assert.doesNotMatch(flagsSection, /--metadata/);
});

test('root help routes detailed reference material to progressive topics', async () => {
  const rootHelp = await usage();
  const commandsHelp = await usageForCommand('commands');
  const workflowHelp = await usageForCommand('workflow');
  if (commandsHelp === null || workflowHelp === null) {
    throw new Error('Expected commands and workflow help text');
  }

  assert.match(rootHelp, /All \d+ commands: agent-device help commands/);
  assert.match(rootHelp, /workflow\s+full refs, selectors, waits, recovery/);
  assert.doesNotMatch(rootHelp, /^Configuration:/m);
  assert.doesNotMatch(rootHelp, /^Environment:/m);

  assert.match(commandsHelp, /^Configuration:/m);
  assert.match(commandsHelp, /Default config files: ~\/\.agent-device\/config\.json/);
  assert.match(commandsHelp, /^Environment:/m);
  assert.match(commandsHelp, /AGENT_DEVICE_SESSION\s+Explicit session name/);
  assert.match(commandsHelp, /^Examples:/m);
  assert.match(commandsHelp, /agent-device open Settings --platform ios/);

  assert.match(workflowHelp, /Command shapes, refs, selectors, waits, recovery/);
  assert.match(workflowHelp, /run serially within one session/i);
  assert.match(workflowHelp, /Wait failure contract:/);
});
test('usageForCommand resolves Maestro compatibility help topic', async () => {
  const help = await usageForCommand('maestro');
  if (help === null) throw new Error('Expected Maestro help text');
  assert.match(help, /Supported subset:/);
  assert.match(help, /runFlow file\/inline/);
  assert.match(help, /tapOn, doubleTapOn, longPressOn/);
  assert.match(help, /inputText on the focused element/);
  assert.match(help, /selector targets poll until available/);
  assert.match(help, /Boundaries:/);
  assert.match(help, /iOS and Android only/);
  assert.match(help, /AD_VAR_\* overrides it/);
  assert.match(help, /may make http\.post network requests/);
  assert.match(help, /not a security sandbox/);
  assert.match(help, /0015-direct-maestro-engine\.md/);
  assert.doesNotMatch(help, /issues\/558/);
});

test('usageForCommand resolves workflow help topic', async () => {
  const help = await usageForCommand('workflow');
  if (help === null) throw new Error('Expected workflow help text');
  assert.match(help, /^agent-device \S+ — workflow/);
  assert.ok(
    Buffer.byteLength(help, 'utf8') < 9100,
    `workflow help topic should stay close to the compact-card size target, was ${Buffer.byteLength(help, 'utf8')} bytes`,
  );
  assert.match(help, /open -> snapshot -i -> settle -> verify -> close loop/);
  assert.match(help, /type never takes --settle/);
  assert.match(
    help,
    /Chain confident consecutive steps with &&: press 'label="Search"' --settle && fill 'label="Search"' "query" --settle/,
  );
  assert.match(help, /Fall back to one command at a time when a step is uncertain/);
  assert.match(help, /never a placeholder \(@ref, @eN, @Label_Name\)/);
  assert.match(
    help,
    /iOS rejects a stale pinned ref -- refresh with snapshot -i or use a selector/,
  );
  assert.match(help, /Known flow: batch \.\/steps\.json \(help scripting\)/);
  assert.match(help, /Shapes and platform quirks: help gestures/);
  assert.match(
    help,
    /open --foreground -> snapshot\. Selection: explicit --device\/--udid\/--serial, then session, booted\/bootable local, or one provider; --platform\/--target only filter\./,
  );
  assert.match(help, /Never open artifact paths or invent package ids/);
  assert.match(
    help,
    /Apple CI: prepare ios-runner after boot\/install, before replay\/test \(help prepare\)/,
  );
  assert.match(help, /Reusable scripts, secret-safe fills, replay repair: help scripting/);
  assert.match(help, /snapshot -i gets current interactive refs only/);
  assert.match(help, /Legend: @e12 \[button\] label="Add to cart"/);
  assert.match(help, /open\/--relaunch clears the stored snapshot outright/);
  assert.match(
    help,
    /A known selector\/label after a mutation is often enough, since interaction commands refresh state internally/,
  );
  assert.match(help, /TV\/D-pad focus: help tv/);
  assert.match(help, /not bare role keys \(button="Search"\)/);
  assert.match(help, /Matches in distinct subtrees fail with AMBIGUOUS_MATCH/);
  assert.match(help, /geometry never chooses a winner/);
  assert.match(help, /iOS AX flags are unreliable on deep RN trees/);
  assert.match(help, /targetHittable: false plus a hint -- verify or re-target, not a failure/);
  assert.match(
    help,
    /Empty replacement is not a clear-field command \(do not plan fill <target> ""\)/,
  );
  assert.match(help, /retry with --delay-ms before clipboard paste/);
  assert.match(
    help,
    /keyboard dismiss taps its own dismiss key when one exists, else UNSUPPORTED_OPERATION/,
  );
  assert.match(help, /prefer type "\\n" to submit/);
  assert.match(
    help,
    /iOS paste-prompt limits and Android IME\/handwriting capture quirks: help debugging/,
  );
  assert.match(help, /run serially within one session/);
  assert.match(help, /Wait failure contract:/);
  assert.match(help, /wait_target_absent: a readable capture ran and found no match/);
  assert.match(help, /wait_capture_stalled: no readable capture finished before the deadline/);
  assert.match(help, /wait_deadline_exceeded: a later capture used the remaining budget/);
  assert.match(help, /wait_landmark_identity_mismatch: a replay destination guard/);
  assert.match(help, /wait_stable_timeout: wait stable never saw a stable UI/);
  assert.match(help, /Ambiguous find: add --first or --last/);
  assert.match(help, /macOS context menus are secondary clicks \(help macos\)/);
  assert.match(help, /Nearby mutation diff: diff snapshot -i/);
  assert.match(help, /initializes the baseline \(zero changes\) instead of failing/);
  assert.match(
    help,
    /confirm the requested end state is actually visible on the current screen, scrolling it into view if needed/,
  );
  assert.match(help, /get text alone, or stopping one screen early, is not enough/);
  assert.match(
    help,
    /iOS merged: child ref => press it; else press parent @ref --settle\. Names are not selectors/,
  );
  assert.match(help, /Perf\/memory\/log\/network\/trace\/crash: help debugging/);
  assert.match(help, /Recording, save-script, batch, replay repair: help scripting/);
  assert.match(help, /help react-native for Metro\/Re\.Pack reload/);
  assert.match(help, /Lifecycle facts \(trust these instead of probing\)/);
  assert.match(help, /open without --relaunch is idempotent-foreground/);
  assert.match(help, /already owned by another agent-device daemon/);
  assert.match(help, /Env vars: help physical-device/);
  assert.match(help, /Escalate:/);
  assert.match(help, /help scripting recording, save-script, batch, replay repair/);
  assert.match(help, /help gestures multi-touch gesture shapes\/quirks/);
  assert.match(help, /help react-devtools/);
  assert.match(help, /help react-native/);
  assert.doesNotMatch(help, /agent-device react-devtools profile/);
  // Deep content moved out of the compact card, not deleted: it now lives in the
  // owning sub-topic (see the corresponding topic tests below).
  assert.doesNotMatch(help, /prepare ios-runner builds\/reuses the XCTest runner/);
  assert.doesNotMatch(
    help,
    /agent-device fill 'id="password"' "\$AD_VAR_PASSWORD" --record-as PASSWORD/,
  );
  assert.doesNotMatch(help, /REPLAY_DIVERGENCE/);
  assert.doesNotMatch(help, /gesture transform 200 420 80 -40 2 35 700/);
});

test('usageForCommand resolves scripting help topic', async () => {
  const help = await usageForCommand('scripting');
  if (help === null) throw new Error('Expected scripting help text');
  assert.match(help, /^agent-device \S+ — scripting/);
  assert.match(help, /agent-device open com\.example\.app --relaunch --save-script=screen-x\.ad/);
  assert.match(help, /agent-device session save-script/);
  assert.match(help, /publishes the sole recorded open through the destination guard/);
  assert.match(help, /A second successful open aborts publication/);
  assert.match(help, /export AD_VAR_PASSWORD='<secret>'/);
  assert.match(help, /agent-device fill 'id="password"' "\$AD_VAR_PASSWORD" --record-as PASSWORD/);
  assert.match(help, /published script contain only \$\{PASSWORD\}/);
  assert.match(help, /Do not record passwords\/tokens without --record-as/);
  assert.match(help, /test --json marks a failed test with infrastructure: true/);
  assert.match(help, /It remains a failed test/);
  assert.match(help, /REPLAY_DIVERGENCE with a bounded report/);
  assert.match(help, /replay --from <n> --plan-digest <sha256>/);
  assert.match(help, /resume never re-executes skipped steps/);
  assert.match(help, /replay <file>\.ad --keep-session/);
  assert.match(help, /--update\/-u is a no-op \(ADR 0012\)/);
  assert.match(help, /record-and-heal means press the correct control via a blessed @ref/);
  assert.match(help, /state-repair means the script is correct but app state is not/);
  assert.match(help, /close --save-script\[=<out>\] \(default <stem>\.healed\.ad\)/);
  assert.match(help, /agent-device batch --steps '\[\{"command":"open"/);
  assert.match(help, /Never use args, step positionals, or flags in new batch JSON/);
  assert.match(help, /test \.\/e2e\/maestro --maestro --device udid1,emulator-5554 --shard-all 2/);
  assert.match(help, /Android adb screenrecord has a 180s limit/);
  assert.match(help, /--hide-touches skips that for the fastest raw recording/);
  assert.match(help, /trace start \.\/trace\.log, trace stop \.\/trace\.log/);
});

test('usageForCommand resolves gestures help topic', async () => {
  const help = await usageForCommand('gestures');
  if (help === null) throw new Error('Expected gestures help text');
  assert.match(help, /^agent-device \S+ — gestures/);
  assert.match(help, /agent-device gesture pan 200 420 80 -40 700 --pointer-count 2/);
  assert.match(help, /agent-device gesture transform 200 420 80 -40 2 35 700/);
  assert.match(help, /press <x> <y> --count <n> --jitter-px <n> for tap series/);
  assert.match(
    help,
    /iOS simulator transform\/pinch\/rotate use private XCTest synthesis for a continuous two-finger/,
  );
  assert.match(help, /Android transform injects a geometric two-finger path/);
  assert.match(help, /verify semantic app state or coarse per-component effects/);
  assert.match(help, /tvOS coordinate pan and fling preserve only the dominant direction/);
  assert.match(help, /falls back to the visible snapshot union/);
  assert.match(help, /Rare iOS accessibility gap/);
  assert.match(help, /agent-device click @e66 --button secondary --platform macos/);
  assert.match(help, /fixed pixel wheel steps/);
});

test('usageForCommand resolves tv help topic', async () => {
  const help = await usageForCommand('tv');
  if (help === null) throw new Error('Expected tv help text');
  assert.match(help, /^agent-device \S+ — tv/);
  assert.match(help, /agent-device tv-remote press down/);
  assert.match(help, /agent-device screenshot \.\/tv-focus\.png --overlay-refs/);
  assert.match(help, /tv-remote longpress select/);
  assert.match(help, /tv-remote press select --duration-ms 500/);
  assert.match(help, /longpress is CLI sugar for --duration-ms 500/);
  assert.match(help, /ok, center, and enter are input aliases for select/);
  assert.match(help, /do not switch to raw adb keyevent/);
  assert.match(help, /Use --platform ios --target tv/);
  assert.match(help, /agent-device devices --platform vega --target tv/);
  assert.match(help, /Vega OS uses the exact hold duration through inputd-cli/);
  assert.match(help, /Use --platform vega --target tv/);
  assert.match(help, /Initial support is VVD-only/);
  assert.match(help, /Physical Fire TV devices remain unsupported/);
  assert.equal(help.match(/\nVega OS:/g)?.length, 1);
});

test('usageForCommand resolves web help topic', async () => {
  const help = await usageForCommand('web');
  if (help === null) throw new Error('Expected web help text');
  assert.match(help, /^agent-device \S+ — web/);
  assert.match(help, /Browser mechanics come from a managed, pinned agent-browser backend/);
  assert.match(help, /agent-device owns command\/session\/replay integration/);
  assert.match(help, /agent-browser owns browser launch, page control, screenshots/);
  assert.match(
    help,
    /Use --platform web when a browser step belongs inside an agent-device session/,
  );
  assert.match(help, /Use agent-browser directly for standalone web automation/);
  assert.match(help, /agent-device web setup/);
  assert.match(help, /agent-device web doctor/);
  assert.match(help, /agent-device open https:\/\/example\.com --platform web/);
  assert.match(help, /agent-device snapshot -i --platform web/);
  assert.match(help, /agent-device get text @e2 --platform web/);
  assert.match(help, /agent-device is visible 'label="Welcome"' --platform web/);
  assert.match(help, /agent-device find text "Welcome" exists --platform web/);
  assert.match(help, /agent-device click @e12 --platform web/);
  assert.match(help, /agent-device fill @e13 "qa@example\.com" --platform web/);
  assert.match(help, /agent-device wait text "Welcome" 3000 --platform web/);
  assert.match(help, /agent-device network dump 25 --include headers --platform web/);
  assert.match(help, /agent-device audio probe start 10 1000 --platform web/);
  assert.match(help, /Audio probe start uses duration seconds first, then bucket milliseconds/);
  assert.match(help, /agent-device screenshot \.\/artifacts\/web-home\.png --platform web/);
  assert.match(help, /agent-device close --platform web/);
  assert.match(help, /open <url>, snapshot -i, get text\/attrs/);
  assert.match(help, /is visible\/exists\/text, find text\/selector/);
  assert.match(help, /click\/press @ref or selector/);
  assert.match(help, /network dump/);
  assert.match(help, /audio probe/);
  assert.match(help, /network routing\/interception\/HAR/);
  assert.match(help, /Use agent-browser directly for those browser-specific workflows/);
  assert.match(help, /Do not claim web e2e CI exists/);
  assert.match(help, /Do not use native mobile or desktop setup commands/);
});

test('usageForCommand resolves debugging help topic', async () => {
  const help = await usageForCommand('debugging');
  if (help === null) throw new Error('Expected debugging help text');
  assert.match(help, /^agent-device \S+ — debugging/);
  assert.match(help, /Use logs when you need the lead-up timeline/);
  assert.match(help, /relaunches the session app through devicectl process launch --console/);
  assert.match(help, /Use debug symbols when you have crash\.ips\/crash\.log/);
  assert.match(help, /Use Xcode\/LLDB when you need live state/);
  assert.match(help, /debug symbols --artifact crash\.ips --search-path \.\/build/);
  assert.match(help, /Android Java\/R8 mapping\.txt and native ndk-stack\/addr2line/);
  assert.match(help, /network\/audio evidence/);
  assert.match(help, /agent-device alert wait 3000/);
  assert.match(help, /iOS support is runner-derived/);
  assert.match(help, /resolved app executable/);
  assert.match(help, /--launch-console is only for direct iOS simulator app launches/);
  assert.match(help, /runnerLogPath and requestLogPath/);
  assert.match(
    help,
    /AGENT_DEVICE_EXEC_TRACE=1 when you need host-tool spawn timing without full debug streaming/,
  );
  assert.match(help, /open --debug --json/);
  assert.match(help, /open_timing event/);
  assert.match(help, /requests\/<request-id>\.ndjson holds daemon request diagnostics/);
  assert.match(help, /daemon\.log is global daemon lifecycle evidence/);
  assert.match(help, /agent-device perf memory sample --json/);
  assert.match(help, /agent-device audio probe start 10 1000 --platform web/);
  assert.match(help, /agent-device audio probe start 10 1000 --platform macos/);
  assert.match(help, /agent-device audio probe start 10 1000 --platform ios/);
  assert.match(help, /agent-device audio probe start 10 1000 --platform android/);
  assert.match(help, /compact rmsDbfs and peakDbfs arrays/);
  assert.match(help, /requires Screen Recording permission/);
  assert.match(help, /Physical iOS and Android devices are not supported/);
  assert.match(help, /Memory artifact \(android-hprof\): \/tmp\/app\.hprof \(42MB\)/);
  assert.match(help, /Prefer perf memory sample over raw dumpsys\/leaks output/);
  assert.match(help, /Unsupported platforms return artifact\.available=false with reason\/hint/);
  assert.match(help, /Do not use settings permission to answer a dialog already on screen/);
  assert.match(help, /Treat native perf output as the agent evidence/);
  assert.match(help, /sizeBytes=5392410/);
  assert.match(help, /5\.3 MB raw trace stays in the artifact/);
  assert.match(help, /iOS Allow Paste cannot be exercised under XCUITest/);
  assert.match(help, /prefill with clipboard write "some text"/);
  assert.match(help, /Android Gboard handwriting\/stylus UI can capture text/);
  assert.match(help, /targetInput\/actualInput details/);
  assert.match(help, /Do not keep retrying fill\/type against the same field/);
});

test('usageForCommand resolves remote help topic', async () => {
  const help = await usageForCommand('remote');
  if (help === null) throw new Error('Expected remote help text');
  assert.match(help, /agent-device connect/);
  assert.match(help, /Remote connection providers use the same lifecycle/);
  assert.match(help, /connect -> install\/open -> commands -> close -> disconnect/);
  assert.match(help, /agent-device connect cloud discovers the agent-device cloud profile/);
  assert.match(help, /Direct proxy: agent-device connect proxy/);
  assert.match(help, /stores the shared proxy profile and client identity/);
  assert.match(help, /BrowserStack: agent-device connect browserstack/);
  assert.match(help, /AWS Device Farm: agent-device connect aws-device-farm/);
  assert.match(help, /Limrun: agent-device connect limrun/);
  assert.match(help, /It does not create an App Automate session/);
  assert.match(help, /It does not create a remote access session/);
  assert.match(help, /It does not create an instance/);
  assert.match(help, /Read the printed Device, App, Next, and workflow-note lines/);
  assert.match(help, /verification\/device\/app\/liveSession\/nextSteps\/notes/);
  assert.match(help, /Do not run devices or apps as a pre-open catalog probe/);
  assert.match(help, /AWS Device Farm cannot install after allocation/);
  assert.match(help, /agent-device open com\.example\.app --remote-config \.\/remote-config\.json/);
  assert.match(help, /disconnect --remote-config \.\/remote-config\.json/);
  assert.match(help, /connect browserstack --platform android/);
  assert.match(help, /connect aws-device-farm --platform android/);
  assert.match(help, /connect limrun --platform android/);
  assert.match(help, /AWS_REGION=us-west-2 AWS_ACCESS_KEY_ID/);
  assert.match(help, /AWS Device Farm uses the AWS CLI credential chain/);
  assert.match(help, /Prefer short-lived AWS role credentials in CI/);
  assert.match(help, /agent-device artifacts --json/);
  assert.match(help, /Script flow, per-command config/);
  assert.match(help, /Direct proxy flow for a remote Mac/);
  assert.match(help, /agent-device proxy --port 4310/);
  assert.match(
    help,
    /connect proxy --daemon-base-url https:\/\/example\.trycloudflare\.com\/agent-device --daemon-auth-token <token>/,
  );
  assert.match(help, /agent-device open Maps --platform ios/);
  assert.match(help, /agent-device snapshot -i --platform ios/);
  assert.match(help, /agent-device close/);
  assert.match(help, /Proxy device leases are acquired on open/);
  assert.match(help, /expire after five minutes without commands/);
  assert.match(help, /Multiple agents can share one proxy/);
  assert.match(help, /disconnect releases local connection state/);
  assert.match(help, /A busy direct-proxy device error means another agent owns the device/);
  assert.match(help, /Limrun, BrowserStack, and AWS Device Farm through local provider profiles/);
  assert.match(help, /Limrun uses LIMRUN_API_KEY/);
  assert.match(help, /BrowserStack uses BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY/);
  assert.match(help, /Generated connection profiles store app\/device selectors and ARNs/);
  assert.match(help, /Limrun Android supports direct ADB port reverse/);
  assert.match(help, /local\/proxy iOS reports that the runner is already owned/);
  assert.match(help, /same --remote-config to every operational command/);
  assert.match(help, /Do not use --config as a remote profile flag/);
  assert.match(help, /install-from-source --github-actions-artifact org\/repo:artifact/);
});

test('usageForCommand resolves physical-device help topic', async () => {
  const help = await usageForCommand('physical-device');
  if (help === null) throw new Error('Expected physical-device help text');
  assert.match(help, /^agent-device \S+ — physical-device/);
  assert.match(help, /Start with Automatic Signing and only these env vars/);
  assert.match(help, /AGENT_DEVICE_IOS_TEAM_ID=ABCDE12345/);
  assert.match(help, /AGENT_DEVICE_IOS_BUNDLE_ID=com\.yourname\.agentdevice\.runner/);
  assert.match(help, /profile name\/specifier, not a file path/);
  assert.match(help, /Older devices visible only to xctrace use the XCTest backend automatically/);
  assert.match(help, /runner commands travel through macOS usbmuxd/);
  assert.match(
    help,
    /app inventory, install\/reinstall, logs, performance sampling, recording, deep links, and launch arguments/,
  );
  assert.match(help, /idempotent-foreground for an already-running app/);
  assert.match(
    help,
    /one simctl launch --terminate-running-process call instead of a separate terminate-then-launch/,
  );
  assert.match(help, /AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS/);
  assert.match(help, /AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS/);
  assert.match(
    help,
    /a stale iOS runner lease — its owner process dead, or its AGENT_DEVICE_STATE_DIR deleted — is reclaimed automatically/i,
  );
  assert.match(help, /genuinely live owner whose state dir still exists still rejects/);
});

test('usageForCommand resolves ios-system-ui help topic', async () => {
  const help = await usageForCommand('ios-system-ui');
  if (help === null) throw new Error('Expected ios-system-ui help text');
  assert.match(help, /^agent-device \S+ — ios-system-ui/);
  assert.match(help, /agent-device open com\.apple\.springboard --platform ios/);
  assert.match(help, /longpress <x> <y> on an empty area of the home screen/);
  assert.match(help, /discover them from the current snapshot/);
  assert.match(
    help,
    /verified on iOS simulator; physical-iPhone SpringBoard support is not yet verified/,
  );
  assert.match(help, /Do not hard-code Edit\/Done\/Add Widget or other SpringBoard label text/);
  assert.match(help, /Reopen the app bundle under test/);
});

test('usageForCommand resolves manual QA help topic', async () => {
  const help = await usageForCommand('manual-qa');
  if (help === null) throw new Error('Expected manual QA help text');
  assert.match(help, /^agent-device \S+ — manual-qa/);
  assert.match(help, /Execute the script/);
  assert.match(help, /Run snapshot -i to get current refs/);
  assert.match(help, /press\/fill\/click\/longpress <ref-or-selector> --settle/);
  assert.match(help, /A bare screenshot\/snapshot is not verification/);
  assert.match(help, /use fill <target> <text> --settle to replace/);
  assert.match(help, /use type only to append to an already-focused field/);
  assert.match(help, /label="Email" editable=true/);
  assert.match(help, /press 'label="Follow"' --settle/);
  assert.match(help, /Do not use placeholders such as @ref/);
  assert.match(help, /wait_target_absent: a readable capture ran and found no match/);
  assert.match(help, /wait_capture_stalled: no readable capture finished before the deadline/);
});

test('usageForCommand resolves validate help topic', async () => {
  const help = await usageForCommand('validate');
  if (help === null) throw new Error('Expected validate help text');
  assert.match(help, /^agent-device \S+ — validate/);
  assert.match(help, /validating a code change/);
  assert.match(help, /Required freshness gate before device verification/);
  assert.match(help, /For a TypeScript runtime or CLI output change, start with pnpm build/);
  assert.match(help, /For non-Android device verification, run pnpm clean:daemon next/);
  assert.match(help, /run pnpm build:android before pnpm clean:daemon/);
  assert.match(help, /pnpm build:xcuitest/);
  assert.match(help, /Do not build the Apple runner for TypeScript-only changes/);
  assert.match(help, /Use the settled diff as evidence/);
  assert.match(help, /Close sessions and release leases/);
  assert.match(help, /exact key that includes the agent-device package and Xcode version/);
  assert.match(help, /Avoid broad restore-key fallbacks/);
});

test('usageForCommand resolves macos help topic', async () => {
  const help = await usageForCommand('macos');
  if (help === null) throw new Error('Expected macos help text');
  assert.match(help, /agent-device click @e66 --button secondary --platform macos/);
  assert.match(help, /Context menus are not ambient UI/);
  assert.match(help, /menu-item refs/);
});

test('usageForCommand resolves dogfood help topic', async () => {
  const help = await usageForCommand('dogfood');
  if (help === null) throw new Error('Expected dogfood help text');
  assert.match(help, /^agent-device \S+ — dogfood/);
  assert.match(help, /Find user-visible issues from runtime behavior/);
  assert.match(help, /Severity: critical blocks a core flow\/data\/crashes/);
  assert.match(help, /Interactive\/behavioral issues need step screenshots/);
  assert.match(help, /Static\/on-load issues can use one screenshot/);
  assert.match(help, /React Native warning\/error overlays can be real findings/);
  assert.match(help, /Expo Go\/dev-client shells/);
  assert.match(help, /direct Android localhost URL opens with a port auto-configure/);
  assert.match(help, /Keep stateful commands serial within the same session/);
  assert.match(help, /agent-device wait 'role=tab' 10000/);
  assert.match(help, /scroll takes a selector-less direction\+amount form/);
  assert.match(help, /Use --settle to wait for the UI to go quiet/);
  assert.match(help, /prefer agent-device open "Expo Go" <url>/);
  assert.match(help, /dogfood-output\/report\.md/);
  assert.match(help, /ID, severity, category, title, affected flow\/screen/);
  assert.match(help, /Never delete screenshots, videos, traces, or report artifacts/);
  assert.match(help, /screenshot \.\/dogfood-output\/screenshots\/issue-001\.png --overlay-refs/);
});

test('usageForCommand resolves react-devtools help topic', async () => {
  const help = await usageForCommand('react-devtools');
  if (help === null) throw new Error('Expected react-devtools help text');
  assert.match(help, /agent-device react-devtools start/);
  assert.match(help, /agent-device react-devtools wait --component <ComponentName>/);
  assert.match(help, /agent-device react-devtools find <ComponentName> --exact/);
  assert.match(help, /agent-device react-devtools errors/);
  assert.match(help, /agent-device react-devtools profile report @c5/);
  assert.match(help, /agent-device react-devtools profile timeline --limit 20/);
  assert.match(help, /agent-device react-devtools profile export profile\.json/);
  assert.match(
    help,
    /agent-device react-devtools profile diff before\.json after\.json --limit 10/,
  );
  assert.match(help, /render causes and changed props\/state\/hooks/);
  assert.match(help, /Run agent-device react-devtools status first/);
  assert.match(help, /start is not a connection check/);
  assert.match(help, /Always run agent-device react-devtools wait --connected after status/);
  assert.match(help, /logs clear --restart before the first logs mark/);
  assert.match(help, /one bounded first-pass survey/);
  assert.match(help, /profile slow --limit 5 once/);
  assert.match(help, /profile rerenders --limit 5 once/);
  assert.match(help, /profile timeline --limit 20 only when commit timing matters/);
  assert.match(help, /Do not repeatedly raise broad profile slow limits/);
  assert.match(help, /profile report unless you have a specific target/);
  assert.match(help, /agent-device logs mark "before catalog search"/);
  assert.match(help, /agent-device react-devtools profile timeline --limit 20/);
  assert.match(help, /Do not write agent-devtools/);
  assert.match(help, /Every profiling and survey line must begin with agent-device react-devtools/);
  assert.match(help, /agent-device network dump --include headers/);
  assert.match(help, /@c refs reset after reload\/remount/);
  assert.match(help, /use separate sessions\/devices/);
  assert.match(help, /local service tunnel/);
  assert.match(help, /Remote iOS apps attempt the legacy React DevTools websocket/);
});

test('usageForCommand resolves cdp help topic', async () => {
  const help = await usageForCommand('cdp');
  if (help === null) throw new Error('Expected cdp help text');
  assert.match(help, /agent-device cdp target list --url http:\/\/127\.0\.0\.1:8081/);
  assert.match(help, /memory usage sample --label baseline --gc/);
  assert.match(help, /memory snapshot leak-triplet --baseline ms_1 --action ms_2 --cleanup ms_3/);
  assert.match(help, /memory snapshot retainers --snapshot ms_3 --id <node-id>/);
  assert.match(help, /Until cdp has a compact leak report command/);
  assert.match(help, /Avoid cdp profile cpu, trace, network, and console by default/);
  assert.match(help, /React Native\/Hermes implements a subset of browser CDP/);
});

test('usageForCommand resolves react-native help topic', async () => {
  const help = await usageForCommand('react-native');
  if (help === null) throw new Error('Expected react-native help text');
  assert.match(help, /^agent-device \S+ — react-native/);
  assert.match(help, /React Native-specific automation hazards/);
  assert.match(help, /Choose the next help topic/);
  assert.match(help, /help workflow/);
  assert.match(help, /help debugging/);
  assert.match(help, /help react-devtools/);
  assert.match(help, /Help workflow owns the full Expo URL command shapes/);
  assert.match(help, /For app\/package launches, run metro prepare/);
  assert.match(help, /Do not run doctor as routine QA\/dogfood prep/);
  assert.match(help, /Use doctor only when the user asks for setup diagnostics/);
  assert.match(help, /same host context that owns the dev server/);
  assert.match(help, /sandbox probe is not authoritative/);
  assert.match(help, /adb reverse only affects Android device-to-host traffic/);
  assert.match(help, /Multiple local worktrees can reuse one native iOS simulator build/);
  assert.match(help, /--metro-host 127\.0\.0\.1 --metro-port 8081/);
  assert.match(help, /One simulator cannot run two copies of the same bundle id/);
  assert.match(help, /Keep the agent-device react-devtools prefix/);
  assert.match(help, /Use help react-devtools for status\/wait/);
  assert.match(help, /Keep the agent-device cdp prefix/);
  assert.match(help, /Use help cdp for JS heap usage samples/);
  assert.match(help, /logs clear --restart/);
  assert.match(help, /network dump --include headers/);
  assert.match(help, /agent-device open "Agent Device Tester" --platform android/);
  assert.match(help, /Start React Native slow-flow plans with this ordered scaffold/);
  assert.match(help, /include the open command even when it also describes the current screen/);
  assert.match(help, /agent-device react-devtools status/);
  assert.match(help, /Profiling plans need both status and wait --connected before profile start/);
  assert.match(help, /Do not substitute react-devtools start for status/);
  assert.match(help, /If snapshot reports a React Native warning\/error overlay/);
  assert.match(help, /agent-device react-native dismiss-overlay/);
  assert.match(help, /verifies the overlay is gone with a fresh post-dismiss snapshot -i/);
  assert.match(help, /Do not use a plain snapshot after dismiss-overlay/);
  assert.match(help, /When overlay evidence and React diagnostics are required/);
  assert.match(help, /agent-device react-devtools errors/);
  assert.match(help, /overlay is still visible/);
  assert.match(help, /Do not manually press warning\/error text bodies/);
  assert.match(help, /dismiss-overlay command owns the narrow LogBox\/RedBox targeting policy/);
  assert.match(help, /Android runtime permission dialogs and native alerts are handled by alert/);
  assert.match(help, /snapshot times out because the UI never becomes idle/);
  assert.match(help, /Report React render offenders separately/);
});

test('commands topic includes swipe and press series options', async () => {
  const help = await usageForCommand('commands');
  if (help === null) throw new Error('Expected commands help text');
  assert.match(help, /diff <kind>/);
  assert.match(help, /swipe <x1> <y1> <x2> <y2>/);
  assert.match(help, /settings \[area\] \[options\]/);
  assert.doesNotMatch(help, /--pattern one-way\|ping-pong/);
  assert.doesNotMatch(help, /--interval-ms/);
});

test('commands topic renders concise commands inline with descriptions', async () => {
  const help = await usageForCommand('commands');
  if (help === null) throw new Error('Expected commands help text');
  assert.match(help, /Commands:[\s\S]*\n  boot\s{2,}Boot target device\/simulator/);
  assert.match(help, /Commands:[\s\S]*\n  shutdown\s{2,}Shutdown target simulator\/emulator/);
  assert.match(help, /  prepare\s{2,}Pre-warm platform helpers/);
  assert.match(help, /  metro\s{2,}Prepare the dev server or reload apps/);
  assert.match(help, /  perf\s{2,}Check frames, memory, or native profiles/);
  assert.match(help, /  cdp\s{2,}Inspect CDP targets, JS heap, and leaks/);
  assert.match(help, /  react-devtools\s{2,}Inspect components, hooks, and render profiles/);
  assert.match(help, /  proxy\s{2,}Expose a local daemon through an HTTP tunnel/);
  assert.match(help, /  batch --steps <json> \| --steps-file <path>\s{2,}Run multiple commands/);
  assert.match(help, /  test <path-or-glob>\.\.\.\s{2,}Run replay test suites/);
  assert.match(help, /  screenshot \[path\]\s{2,}Capture a screenshot/);
  assert.match(help, /  session\s{2,}List sessions, show the state dir, or publish a script/);
  assert.doesNotMatch(help, /  metro prepare[^\n]*--project-root/);
  assert.doesNotMatch(help, /\n  batch\s{2,}Run multiple commands/);
  assert.doesNotMatch(help, /agent-device-proxy/);
});
