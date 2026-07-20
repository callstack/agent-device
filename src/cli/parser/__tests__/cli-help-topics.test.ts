import { test } from 'vitest';
import assert from 'node:assert/strict';
import { usage, usageForCommand } from '../args.ts';

test('usage includes concise top-level commands', async () => {
  const usageText = await usage();
  assert.match(
    usageText,
    /install-from-source\s{2,}Install app builds from URLs, remote source specs, or CI artifacts/,
  );
  assert.match(usageText, /prepare\s{2,}Pre-warm platform helpers/);
  assert.match(
    usageText,
    /metro\s{2,}Prepare Metro\/Re\.Pack reachability for React Native\/Expo apps or trigger app reloads/,
  );
  assert.match(usageText, /batch --steps <json> \| --steps-file <path>/);
  assert.match(usageText, /network\s{2,}Inspect HTTP\(S\) traffic parsed from session app logs/);
  assert.match(usageText, /clipboard read \| clipboard write <text>/);
  assert.match(usageText, /keyboard \[action\]/);
  assert.match(usageText, /trigger-app-event\s{2,}Invoke app-defined automation\/test events/);
  assert.match(usageText, /gesture <pan\|fling\|swipe\|pinch\|rotate\|transform> \.\.\./);
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

test('usage includes only global flags in the top-level global flags section', async () => {
  const usageText = await usage();
  const flagsSection = usageText.slice(
    usageText.indexOf('Global Flags:'),
    usageText.indexOf('Agent Quickstart:'),
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

test('usage includes agent workflows, config, environment, and examples footers', async () => {
  const usageText = await usage();
  assert.match(
    usageText,
    /CLI to automate supported app, device, desktop, and web targets for AI agents/,
  );
  assert.ok(
    usageText.indexOf('Agent Workflows:') < usageText.indexOf('Commands:'),
    'Agent workflows should appear before the command list for agents that only read the top of help.',
  );
  assert.ok(
    usageText.indexOf('Agent Starting Point:') < usageText.indexOf('Agent Workflows:'),
    'The agent starting point should appear before topic selection.',
  );
  assert.match(usageText, /Agent Starting Point:/);
  assert.match(usageText, /Write full command lines starting with agent-device/);
  assert.match(usageText, /Default app loop: agent-device open <app>/);
  assert.match(usageText, /Use --settle on every mutating app action that supports it/);
  assert.match(usageText, /The settled diff is the next snapshot/);
  assert.match(usageText, /If --settle prints not settled, follow its hint/);
  assert.match(usageText, /Use refs or selectors as targets/);
  assert.match(usageText, /Pick the help mode below/);
  assert.match(usageText, /Agent Quickstart:/);
  assert.match(usageText, /Planning output contract/);
  assert.match(
    usageText,
    /Plain snapshot reads state; snapshot -i refreshes current interactive refs only/,
  );
  assert.match(usageText, /agent-facing, token-efficient view for planning and targeting actions/);
  assert.match(usageText, /Truncated text\/input preview: expand first with snapshot -s @e12/);
  assert.match(usageText, /React Native apps: read help react-native/);
  assert.match(usageText, /use fill <target> <text> --settle to replace a field value/);
  assert.match(usageText, /Use type <text> only to append after focusing a field with press/);
  assert.match(usageText, /do not use fill <target> ""/);
  assert.match(usageText, /Implicit default sessions are scoped to the current worktree/);
  assert.match(usageText, /if a prompt names a Session, include --session <name>/);
  assert.match(usageText, /Run mutating commands serially within one session/);
  assert.match(usageText, /After mutation: refs are stale/);
  assert.match(usageText, /use its selector directly; otherwise refresh with snapshot -i/);
  assert.match(usageText, /fill <targetOrX> <yOrText> \[text\]\s+Replace text in/);
  assert.match(usageText, /type <text>\s+Append text to the focused field/);
  assert.match(usageText, /macOS context menus use click <ref> --button secondary/);
  assert.match(
    usageText,
    /Remote lifecycle: use connect, then open, commands, close, and disconnect/,
  );
  // Deep topic-specific detail (Metro/Expo recovery, Android IME capture, coordinate
  // fallback verification, sparse/AX recovery, direct-proxy flags, back/system-back
  // wording, the full web command sequence) moved out of the bare-help Agent
  // Quickstart section and now lives only in the owning topic (help react-native,
  // help workflow, help remote, help web) so `agent-device help` alone stays small.
  // Those topics assert the same content in their own usageForCommand tests below.
  assert.match(usageText, /TV\/D-pad targets: read help tv\. Web browser sessions: read help web/);
  assert.match(
    usageText,
    /Routine QA loop with concrete command shapes: agent-device help manual-qa/,
  );
  assert.match(usageText, /Session state contains request diagnostics and runner\.log/);
  assert.match(usageText, /logs clear --restart\/mark\/path/);
  assert.match(usageText, /network dump --include headers/);
  assert.match(usageText, /Full operating guide: agent-device help workflow/);
  assert.match(usageText, /Exploratory QA: agent-device help dogfood/);
  assert.match(usageText, /Agent Workflows:/);
  assert.match(
    usageText,
    /agent-device help manual-qa\s+Follow a manual test script with exact interactions and verification/,
  );
  assert.match(
    usageText,
    /agent-device help dogfood\s+Explore an app and report issues with evidence/,
  );
  assert.match(
    usageText,
    /agent-device help validate\s+Validate code changes, perf, visuals, logs, and cleanup/,
  );
  assert.match(
    usageText,
    /agent-device help workflow\s+Full app automation reference for commands, refs, selectors, and waits/,
  );
  assert.match(
    usageText,
    /agent-device help debugging\s+Use when logs, network, audio, perf memory, traces, alerts, or diagnostics matter/,
  );
  assert.match(
    usageText,
    /agent-device help tv\s+Use when navigating Android TV or tvOS focus-first surfaces/,
  );
  assert.match(
    usageText,
    /agent-device help react-devtools\s+Use when inspecting components, props\/state\/hooks, renders, or profiles/,
  );
  assert.match(
    usageText,
    /agent-device help physical-device\s+Use when using a connected phone\/tablet or iOS signing setup/,
  );
  assert.match(
    usageText,
    /agent-device help react-native\s+Use when the target app is React Native, Expo, or a dev client/,
  );
  assert.match(
    usageText,
    /agent-device help web\s+Use when automating a browser through agent-device sessions/,
  );
  assert.match(usageText, /Configuration:/);
  assert.match(
    usageText,
    /Default config files: ~\/\.agent-device\/config\.json, \.\/agent-device\.json/,
  );
  assert.match(
    usageText,
    /Use --config <path> or AGENT_DEVICE_CONFIG to load one explicit config file\./,
  );
  assert.match(usageText, /Environment:/);
  assert.match(usageText, /AGENT_DEVICE_SESSION\s+Explicit session name/);
  assert.match(usageText, /AGENT_DEVICE_PLATFORM\s+Default platform binding/);
  assert.match(usageText, /AGENT_DEVICE_SESSION_LOCK\s+Bound-session conflict mode/);
  assert.match(usageText, /AGENT_DEVICE_DAEMON_BASE_URL\s+Connect to remote daemon/);
  assert.match(usageText, /Examples:/);
  assert.match(usageText, /agent-device open Settings --platform ios/);
  assert.match(usageText, /agent-device open https:\/\/example\.com --platform web/);
  assert.match(usageText, /agent-device snapshot -i/);
  assert.match(usageText, /agent-device fill @e3 "test@example\.com"/);
  assert.match(usageText, /agent-device replay \.\/session\.ad/);
  assert.match(usageText, /agent-device test \.\/suite --platform android/);
});

test('usageForCommand resolves Maestro compatibility help topic', async () => {
  const help = await usageForCommand('maestro');
  if (help === null) throw new Error('Expected Maestro help text');
  assert.match(help, /Supported subset:/);
  assert.match(help, /runFlow file\/inline/);
  assert.match(help, /tapOn, doubleTapOn, longPressOn/);
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
  assert.match(help, /agent-device help workflow/);
  assert.match(help, /Use selectors as positional targets/);
  assert.match(help, /Do not use CSS selectors/);
  assert.match(help, /Snapshot legend:/);
  assert.match(help, /@e12 \[button\] label="Add to cart"/);
  assert.match(help, /Truncated text\/input previews: do not use get text first/);
  assert.match(help, /snapshot -s @e7/);
  assert.match(help, /Use plain fill\/type first for ordinary login and form fields/);
  assert.match(help, /--delay-ms intentionally paces character entry/);
  assert.match(help, /Read-only visible\/state question: use snapshot\/get\/is\/find/);
  assert.match(help, /Use snapshot -i only when refs are needed/);
  assert.match(help, /install-from-source --github-actions-artifact org\/repo:app-debug/);
  assert.match(help, /Discovery is not enough when the task asks to open\/start/);
  assert.match(help, /If the task says install, use install/);
  assert.match(help, /Do not open artifact paths or invent package ids/);
  assert.match(help, /agent-device get attrs @e4/);
  assert.match(help, /Ambiguous find: add --first or --last/);
  assert.match(help, /report that gap instead of typing\/searching\/navigating/);
  assert.match(help, /App-owned action sheets, menus, and camera\/scan screens are normal UI/);
  assert.match(help, /wait for a concrete result before returning to chat\/form state/);
  assert.match(help, /choose a point near the center of the intended app-owned target/);
  assert.match(help, /Avoid screen edges, tab bars, navigation bars, and home indicators/);
  assert.match(help, /Android transform injects a geometric two-finger path/);
  assert.match(help, /verify semantic app state or coarse per-component effects/);
  assert.match(help, /instead of exact numeric deltas/);
  assert.match(help, /prefer isolated gesture pan --pointer-count 2, gesture pinch/);
  assert.match(help, /gesture pan is one finger by default/);
  assert.match(help, /--pointer-count 2 for a parallel two-finger pan/);
  assert.match(help, /falls back to the visible snapshot union/);
  assert.match(help, /tvOS coordinate pan and fling preserve only the dominant direction/);
  assert.match(help, /longpress accepts coordinates, @refs, or selectors/);
  assert.match(help, /use help react-native for Metro\/Re\.Pack Fast Refresh/);
  assert.match(help, /iOS Allow Paste prompt cannot be exercised under XCUITest/);
  assert.match(help, /Empty replacement is not a supported clear-field command/);
  assert.match(help, /do not plan fill <target> ""/);
  assert.match(help, /To hide the keyboard, use keyboard dismiss/);
  assert.match(
    help,
    /On iOS, if it returns UNSUPPORTED_OPERATION, there is no generic app-agnostic blur fallback/,
  );
  assert.match(help, /On Android, keyboard dismiss first avoids navigation/);
  assert.match(help, /use back only when normal back behavior is acceptable/);
  assert.match(help, /UNSUPPORTED_OPERATION/);
  assert.match(help, /Stateful commands within one session must run serially/);
  assert.match(
    help,
    /Do not run open\/press\/fill\/type\/scroll\/back\/alert\/replay\/batch\/close commands in parallel/,
  );
  assert.match(help, /agent-device clipboard write "some text"/);
  assert.match(help, /For gesture-heavy iOS simulator proof videos, prefer --hide-touches/);
  assert.match(help, /only a means to reveal or reach an expected target/);
  assert.match(help, /using the id, selector, or text named by the task/);
  assert.match(
    help,
    /iOS simulator transform uses private XCTest synthesis for a continuous two-finger pan\/scale\/rotation path/,
  );
  assert.match(help, /Android Gboard handwriting\/stylus UI can capture text/);
  assert.match(help, /targetInput\/actualInput details/);
  assert.match(help, /Do not keep retrying fill\/type against the same field/);
  assert.match(help, /provider-native text injection when available/);
  assert.match(help, /Do not switch to raw adb, clipboard, or paste as an agent fallback/);
  assert.match(help, /if no URL is provided but a target\/app name is provided, open that target/);
  assert.match(help, /localhost\/127\.0\.0\.1\/\[::1\] with a port auto-configure/);
  assert.match(help, /Manual adb reverse tcp:<port> tcp:<port> is only needed/);
  assert.match(help, /do not stop at the action itself/);
  assert.match(help, /do not split clear\/restart/);
  assert.match(help, /do not write network log headers/);
  assert.match(help, /Web: agent-device uses a managed, pinned agent-browser backend/);
  assert.match(
    help,
    /Use --platform web when a browser step belongs inside an agent-device session/,
  );
  assert.match(help, /use agent-browser directly for standalone web automation/);
  assert.match(help, /agent-device web setup/);
  assert.match(help, /agent-device web doctor/);
  assert.match(help, /agent-device open https:\/\/example\.com --platform web/);
  assert.match(help, /agent-device get text @e2 --platform web/);
  assert.match(help, /agent-device is visible 'label="Welcome"' --platform web/);
  assert.match(help, /agent-device find text "Welcome" exists --platform web/);
  assert.match(help, /agent-device close --platform web/);
  assert.match(help, /Use agent-browser directly for browser-specific features/);
  assert.match(help, /agent-device open exp:\/\/127\.0\.0\.1:8081 --platform ios/);
  assert.match(help, /agent-device open "Expo Go" exp:\/\/127\.0\.0\.1:8081 --platform ios/);
  assert.match(help, /There is no open-url command/);
  assert.match(help, /direct URL open can report success while leaving the runner\/shell focused/);
  assert.match(help, /verify with snapshot -i after opening/);
  assert.match(help, /snapshot returns a sparse\/AX-unavailable state/);
  assert.match(help, /Use plain screenshot, not screenshot --overlay-refs/);
  assert.match(help, /retry snapshot -i after reaching another screen/);
  assert.match(help, /test \.\/e2e\/maestro --maestro --device udid1,emulator-5554 --shard-all 2/);
  assert.match(help, /agent-device open exp:\/\/127\.0\.0\.1:8081 --platform android/);
  assert.match(help, /apps lookup misses the project but shows Expo Go\/dev-client/);
  assert.match(help, /metro prepare --kind expo/);
  assert.match(help, /agent-device prepare ios-runner --platform ios --timeout 240000/);
  assert.match(help, /prepare ios-runner builds\/reuses the XCTest runner/);
  assert.match(
    help,
    /not a recovery step for "runner already owned by another agent-device daemon"/,
  );
  assert.match(help, /prepared runner does not keep a live lease/);
  assert.match(help, /help react-devtools/);
  assert.match(help, /help react-native/);
  assert.doesNotMatch(help, /agent-device react-devtools profile/);
});

test('usageForCommand resolves tv help topic', async () => {
  const help = await usageForCommand('tv');
  if (help === null) throw new Error('Expected tv help text');
  assert.match(help, /agent-device help tv/);
  assert.match(help, /agent-device tv-remote press down/);
  assert.match(help, /agent-device screenshot \.\/tv-focus\.png --overlay-refs/);
  assert.match(help, /tv-remote longpress select/);
  assert.match(help, /tv-remote press select --duration-ms 500/);
  assert.match(help, /longpress is CLI sugar for --duration-ms 500/);
  assert.match(help, /ok, center, and enter are input aliases for select/);
  assert.match(help, /do not switch to raw adb keyevent/);
  assert.match(help, /Use --platform ios --target tv/);
});

test('usageForCommand resolves web help topic', async () => {
  const help = await usageForCommand('web');
  if (help === null) throw new Error('Expected web help text');
  assert.match(help, /agent-device help web/);
  assert.match(help, /agent-device uses a managed, pinned agent-browser backend/);
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
  assert.match(help, /agent-device help debugging/);
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
});

test('usageForCommand resolves remote help topic', async () => {
  const help = await usageForCommand('remote');
  if (help === null) throw new Error('Expected remote help text');
  assert.match(help, /agent-device connect/);
  assert.match(help, /Remote connection providers use the same lifecycle/);
  assert.match(help, /connect -> open -> commands -> close -> disconnect/);
  assert.match(help, /agent-device connect cloud discovers the agent-device cloud profile/);
  assert.match(help, /Direct proxy: agent-device connect proxy/);
  assert.match(help, /stores the shared proxy profile and client identity/);
  assert.match(help, /BrowserStack: agent-device connect browserstack/);
  assert.match(help, /AWS Device Farm: agent-device connect aws-device-farm/);
  assert.match(help, /Limrun: agent-device connect limrun/);
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
  assert.match(help, /Device leases are acquired on open/);
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
  assert.match(help, /agent-device help physical-device/);
  assert.match(help, /Start with Automatic Signing and only these env vars/);
  assert.match(help, /AGENT_DEVICE_IOS_TEAM_ID=ABCDE12345/);
  assert.match(help, /AGENT_DEVICE_IOS_BUNDLE_ID=com\.yourname\.agentdevice\.runner/);
  assert.match(help, /profile name\/specifier, not a file path/);
});

test('usageForCommand resolves manual QA help topic', async () => {
  const help = await usageForCommand('manual-qa');
  if (help === null) throw new Error('Expected manual QA help text');
  assert.match(help, /agent-device help manual-qa/);
  assert.match(help, /Execute the script/);
  assert.match(help, /Run snapshot -i to get current refs/);
  assert.match(help, /press\/fill\/click\/longpress <ref-or-selector> --settle/);
  assert.match(help, /A bare screenshot\/snapshot is not verification/);
  assert.match(help, /use fill <target> <text> --settle to replace/);
  assert.match(help, /use type only to append to an already-focused field/);
  assert.match(help, /Do not use placeholders such as @ref/);
});

test('usageForCommand resolves validate help topic', async () => {
  const help = await usageForCommand('validate');
  if (help === null) throw new Error('Expected validate help text');
  assert.match(help, /agent-device help validate/);
  assert.match(help, /validating a code change/);
  assert.match(help, /pnpm build first, then pnpm clean:daemon/);
  assert.match(help, /pnpm build:xcuitest/);
  assert.match(help, /Use the settled diff as evidence/);
  assert.match(help, /Close sessions and release leases/);
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
  assert.match(help, /agent-device help dogfood/);
  assert.match(help, /Find user-visible issues from runtime behavior/);
  assert.match(help, /Severity: critical blocks a core flow\/data\/crashes/);
  assert.match(help, /Interactive\/behavioral issues need step screenshots/);
  assert.match(help, /Static\/on-load issues can use one screenshot/);
  assert.match(help, /React Native warning\/error overlays can be real findings/);
  assert.match(help, /Expo Go\/dev-client shells/);
  assert.match(help, /direct Android localhost URL opens with a port auto-configure/);
  assert.match(help, /Keep stateful commands serial within the same session/);
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
  assert.match(help, /agent-device help react-native/);
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

test('usage includes swipe and press series options', async () => {
  const help = await usage();
  assert.match(help, /diff <kind>/);
  assert.match(help, /swipe <x1> <y1> <x2> <y2>/);
  assert.match(help, /settings \[area\] \[options\]/);
  assert.doesNotMatch(help, /--pattern one-way\|ping-pong/);
  assert.doesNotMatch(help, /--interval-ms/);
});

test('usage renders concise commands inline with descriptions', async () => {
  const help = await usage();
  assert.match(help, /Commands:[\s\S]*\n  boot\s{2,}Boot target device\/simulator/);
  assert.match(help, /Commands:[\s\S]*\n  shutdown\s{2,}Shutdown target simulator\/emulator/);
  assert.match(help, /  prepare\s{2,}Pre-warm platform helpers/);
  assert.match(
    help,
    /  metro\s{2,}Prepare Metro\/Re\.Pack reachability for React Native\/Expo apps/,
  );
  assert.match(help, /  perf\s{2,}Check runtime metrics, frames, memory, CPU profiles/);
  assert.match(help, /  cdp\s{2,}Inspect React Native CDP targets, JS heap growth/);
  assert.match(help, /  react-devtools\s{2,}Inspect React Native components, props, hooks/);
  assert.match(help, /  proxy\s{2,}Expose a local daemon through cloudflared, ngrok/);
  assert.match(help, /  batch --steps <json> \| --steps-file <path>\s{2,}Run multiple commands/);
  assert.match(help, /  test <path-or-glob>\.\.\.\s{2,}Run replay test suites/);
  assert.match(
    help,
    /  screenshot \[path\]\s{2,}Capture screenshot with optional density, full-page, desktop/,
  );
  assert.match(
    help,
    /  session\s{2,}List active sessions or print the effective daemon state directory/,
  );
  assert.doesNotMatch(help, /  metro prepare[^\n]*--project-root/);
  assert.doesNotMatch(help, /\n  batch\s{2,}Run multiple commands/);
  assert.doesNotMatch(help, /agent-device-proxy/);
});
