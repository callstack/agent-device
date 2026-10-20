import assert from 'node:assert/strict';
import { test } from 'vitest';
import { usage, usageForCommand } from '../../cli/parser/args.ts';
import { helpTopicIds } from './cli-help.ts';

// Agents often read only the first screen of a help text, and the help benchmark caps the root
// help at 30 lines (`--help:first30`). Each entry pins the rules that keep an agent safe on that
// screen: prerequisites, refusals, verification steps, and recovery. A new topic must declare its
// own entry.
const FIRST_SCREEN_LINES = 30;
const ROOT_HELP = '--help';

const FIRST_SCREEN_RULES: Record<string, readonly string[]> = {
  [ROOT_HELP]: [
    'agent-device open <app> --foreground',
    'Do not probe first with devices, apps, appstate, snapshot, or screenshot',
    'Unknown app id: devices, then apps, then open <discovered-id>. Never invent ids',
    'is, get, or find. A bare screenshot is not verification',
    'End with: agent-device close',
  ],
  commands: [
    'Full command catalog. Use agent-device help <command> for exact flags and behavior',
    'Commands:',
  ],
  'manual-qa': [
    'Execute the script. Do not explore unrelated screens',
    'Stop and report ambiguity',
    '1. Open the requested app; use --relaunch only when the script needs fresh state',
    '5. If --settle prints not settled, follow its hint',
    '6. Verify named expectations with wait text/selector/absent, get, is, find, or the settled diff. A bare screenshot/snapshot is not verification',
  ],
  maestro: [
    'Run Maestro compatibility flows with replay <flow.yaml> --maestro',
    '- Flows: launchApp (with clearState, permissions, and Apple-only launch arguments; permissions apply after state clearing but before launch, and a launchApp without permissions touches nothing — there is no silent all: allow default',
    '- Failure diagnostics: resolved targets and runFlow paths are rendered, while inputText payloads remain hidden; do not place secrets in diagnostic identifiers',
    '- Trust: runScript, evalScript, and JavaScript condition true: fields execute flow scripts in-process via node:vm, which is not a security sandbox',
    'Unsupported syntax fails loudly',
  ],
  workflow: [
    'Refs look like @e12; use the exact ref from the latest snapshot -i, never a placeholder (@ref, @eN, @Label_Name)',
    'Refs look like @e12; use the exact ref from the latest snapshot -i, never a placeholder (@ref, @eN, @Label_Name). Pin with ~s<n> (press @e12~s4); every platform rejects a stale pinned ref',
    'Unknown app id: devices, then apps, then open <discovered-app-id>. Never open artifact paths or invent package ids',
    'Truncated preview: snapshot -s @e12 (the current concrete ref), not get text. Missing target: scroll <dir> --until <selector>. TV/D-pad focus: help tv',
    'Mutating selector ambiguity: press/click/fill/longpress collapse duplicate accessibility wrappers only when every match is one ancestor-descendant chain resolving to the same actionable node. Matches in distinct subtrees fail with AMBIGUOUS_MATCH',
  ],
  scripting: [
    'Reaching an off-screen target is viewport-independent in a script the same way it is at the CLI: write scroll down --until <selector>',
    'press/click/longpress resolve their target once. Before interacting with a loading screen, add an explicit landmark wait',
    'agent-device fill \'id="password"\' "$AD_VAR_PASSWORD" --record-as PASSWORD',
    'The live app receives the value; recording state and the published script contain only ${PASSWORD}',
    '--text-stdin reads at most 64 KiB, removes exactly one trailing newline, and refuses a terminal, empty input, invalid UTF-8',
  ],
  gestures: [
    'longpress accepts coordinates, @refs, or selectors; prefer @ref/selector, coordinates only as a fallback',
    'iOS transform/pinch/rotate use private XCTest synthesis for a continuous two-finger pan/scale/rotation path; verify app metrics instead of assuming requested values map exactly to recognizer output',
    'Rare iOS accessibility gap: a row shown disabled/hittable:false where press reports success but no UI change, or a collapsed composite control with no child refs -- run snapshot -i --json, compute the target center from rects, press x y, then diff snapshot -i. Coordinates are fallback-only; document why you used them.',
  ],
  tv: [
    'Use this when the target is Android TV, Apple TV/tvOS, or an Amazon Vega OS TV app running in the Vega Virtual Device (VVD). TV surfaces are focus-first: move focus with remote/D-pad buttons, then activate the focused control',
    'Vega OS is driven through the SDK-matched Vega CLI and VDA, not ADB',
    'Initial support is VVD-only. Physical Fire TV devices remain unsupported',
    'The VVD is never booted implicitly',
    'Snapshot, screenshot, selectors, install, touch/text/gesture, logs, and performance commands remain unsupported until their Vega backends are implemented',
  ],
  debugging: [
    'Do not cat a full stale log into agent context',
    'logs clear --restart is the compact command to clear old logs and start a fresh capture; do not split it into logs stop, logs clear, logs start',
    '--launch-console is only for direct iOS simulator app launches, not URL opens',
    'network log is a supported alias, but network dump --include headers is the clearest plan form. Do not write network log headers',
  ],
  'react-devtools': [
    "Every command except profile report and profile commit, which read the saved profile, attaches to the app's JavaScript runtime through its Metro dev server: a development build on React Native 0.74 or newer",
    'Refs are DevTools element ids: they change when a component remounts or the app reloads, so find again after either',
    'With a React DevTools window connected to the app, tree, find, errors, and inspect by name fail with tree-unavailable',
    '1. Run profile start immediately before the interaction',
  ],
  cdp: [
    'state. Do not use this as the default React Native profiler',
    'Start Metro and open the app first. For Android devices/emulators, make sure Metro is reachable from the app, typically with adb reverse tcp:8081 tcp:8081',
    'agent-device cdp target select <target-id>',
    'agent-device cdp memory snapshot leak-triplet',
  ],
  'react-native': [
    'Do not run doctor as routine QA/dogfood prep',
    'For "start from screen X" flows, prefer open --relaunch before the first snapshot',
    'Do not use agent-device reload',
    'Verify Metro/Re.Pack from the same host context that owns the dev server. If a sandboxed shell cannot curl localhost:8081/status but an unrestricted host shell can, the dev server is running and the sandbox probe is not authoritative',
    'Expo Go/dev clients are host shells. Use provided project URLs, verify with snapshot -i after opening, and ask instead of inventing app ids or URLs',
  ],
  'physical-device': [
    'The device must be paired/trusted, connected, unlocked when needed, and have Developer Mode enabled',
    'The AgentDeviceRunner XCTest host must be signed before commands can run on a physical device',
    'A runner startup failure names its class in error details.reason rather than only in prose:',
    'Enable USB debugging',
  ],
  'ios-system-ui': [
    '1. Reach the app state you want to prepare (for example, arrange the widget/Live Activity data the app should show) with normal app automation, then agent-device open com.apple.springboard --platform ios',
    'This works today by opening SpringBoard as the session app; there is no separate widget/system command. System labels vary by iOS version and locale, so discover them from the current snapshot instead of relying on the literal strings',
    '3. agent-device longpress <x> <y> on an empty area of the home screen to enter edit mode. This is the one deliberate coordinate step',
    'Do not hard-code Edit/Done/Add Widget',
    '9. Reopen the app bundle under test',
  ],
  foldable: [
    "Each iOS simulator capture resolves the CoreDevice display table, selects the sole lit panel when power identifies it, and normalizes density with that panel's own point scale. There is no screen flag. When panel power names no single lit panel, the capture names CoreDevice's primary panel, which may be dark and yield an all-black PNG. Check the pose with UIHinge.status before trusting that capture. With no primary panel either, capture fails with COMMAND_FAILED and reason capture-panel-unidentified rather than pick a panel by list order.",
    'The two panels are different sizes (iPhone Duo: 466x678 points closed on the outer panel, 669x951 open on the inner). A pose change therefore invalidates every ref and coordinate. Re-snapshot after any pose change and never carry coordinates or refs across',
    'Expect a fold to take 10-16 seconds: each hinge read is a five-second devicectl stream, and half-open waits for the hinge to stop moving. Re-snapshot after every fold',
    'fold sends a private HID hinge event inside the selected simulator',
    'If a task asserts behavior for more than one pose, fold to each pose and re-snapshot, and report which poses the run covered',
  ],
  remote: [
    'connect -> install/open -> commands -> close -> disconnect',
    'BrowserStack, AWS Device Farm, and TestMu AI create the hosted session on open. open needs the installed package or bundle identifier, not the app artifact name, ARN, or lt:// id',
    'AWS Device Farm cannot install after allocation. If connect reports no attached app, run its printed reconnect command',
    'Do not run devices as a pre-open catalog probe for direct providers',
    'MCP exposes operational tools such as open, snapshot, click, close, and artifacts. It does not expose connect/disconnect',
  ],
  macos: [
    'Use open and snapshot -i for menu bar inspection. Do not output inspect as a command',
    'agent-device click @e66 --button secondary',
    'Do not let iOS simulator-set scoping hide macOS desktop targets',
    'macOS snapshot rects are window-space; use current refs or overlay refs instead of guessing coordinates',
    'On the default XCTest backend a read (snapshot, get, find) of a session app that sits behind other windows is answered from where it sits, without raising the app',
  ],
  web: [
    'Use --platform web only for the minimal browser command loop',
    'agent-device web doctor',
    'Web automation requires Node 24+',
    'For web command plans, output only agent-device command lines',
  ],
  dogfood: [
    'Find user-visible issues from runtime behavior. Do not read app source or invent findings from code',
    '1. Identify target app/platform; ask only if missing',
    'Keep stateful commands serial within the same session',
    'React Native warning/error overlays can be real findings or test blockers. Capture them, use react-native dismiss-overlay',
  ],
  validate: [
    'Prove the changed behavior through public agent-device surfaces. Do not validate against stale dist output',
    'For a TypeScript runtime or CLI output change, start with pnpm build',
    'Before local Android verification, run pnpm build:android before pnpm clean:daemon',
    'For an Apple runner change, run pnpm build:xcuitest and avoid inherited retained runners from older source. Do not build the Apple runner for TypeScript-only changes',
    '6. Close sessions and release leases before finishing',
  ],
};

// A rule counts only when a whole rendered line carries it: the trimmed line equals the
// rule, or starts with it and the rule ends at a word boundary. A substring match would
// let a short generic rule like 'Commands:' pass from inside unrelated prose.
function ruleMatchesLine(line: string, rule: string): boolean {
  const trimmed = line.trim();
  if (trimmed === rule) return true;
  if (!trimmed.startsWith(rule)) return false;
  return !/[\w-]/.test(trimmed[rule.length] ?? '');
}

function assertRulesInFirstScreen(lines: readonly string[], rules: readonly string[]): void {
  for (const rule of rules) {
    const line = lines.findIndex((text) => ruleMatchesLine(text, rule)) + 1;
    assert.ok(
      line > 0 && line <= FIRST_SCREEN_LINES,
      line > 0
        ? `"${rule}" is on line ${line}, below the first ${FIRST_SCREEN_LINES} lines`
        : `"${rule}" has no matching line`,
    );
  }
}

async function renderHelp(id: string): Promise<string> {
  if (id === ROOT_HELP) return await usage();
  const text = await usageForCommand(id);
  if (text === null) throw new Error(`Expected help text for topic ${id}`);
  return text;
}

test('every help topic and the root help declare first-screen rules', () => {
  assert.deepEqual(Object.keys(FIRST_SCREEN_RULES).sort(), [ROOT_HELP, ...helpTopicIds()].sort());
});

test.each(Object.entries(FIRST_SCREEN_RULES))(
  'help %s keeps its key rules in the first 30 lines',
  async (id, rules) => {
    assertRulesInFirstScreen((await renderHelp(id)).split('\n'), rules);
  },
);

test('a rule matches only whole lines, not prose, a moved rule, or a deleted rule', () => {
  // Short generic rules must not pass from inside unrelated prose.
  const prose = [
    'Some unrelated sentence that merely quotes Commands: in passing, far from any list.',
  ];
  assert.equal(ruleMatchesLine(prose[0]!, 'Commands:'), false);
  assert.throws(() => assertRulesInFirstScreen(prose, ['Commands:']), /no matching line/);

  // A rule pushed below the window fails.
  const filler = Array.from({ length: 40 }, (_, i) => `filler line ${i + 1}`);
  filler[34] = 'Commands:';
  assert.throws(
    () => assertRulesInFirstScreen(filler, ['Commands:']),
    /"Commands:" is on line 35, below the first 30 lines/,
  );

  // A deleted rule fails.
  filler[34] = 'filler line 35';
  assert.throws(() => assertRulesInFirstScreen(filler, ['Commands:']), /no matching line/);

  // Prefixes count only at a word boundary, not mid-word.
  assert.equal(ruleMatchesLine('  Commands: are listed below', 'Commands:'), true);
  assert.equal(ruleMatchesLine('SubCommands: here', 'Commands:'), false);
});
