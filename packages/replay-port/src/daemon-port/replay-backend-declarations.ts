import type { ReplayFormat } from '@agent-device/ad-script';
import type { ReplayBackendDeclaration } from '@agent-device/contracts/replay-backend';

export const MAESTRO_COMPAT_SUPPORTED_CAPABILITIES = [
  'Flows: launchApp (with clearState, permissions, and Apple-only launch arguments; permissions apply after state clearing but before launch, and a launchApp without permissions touches nothing — there is no silent all: allow default); setPermissions (mid-flow permission grants, denials, and resets; all resolves in the backend — one simctl call on iOS, the declared permissions on Android — with specific entries overriding after it); runFlow file/inline; runFlow.when and repeat.while conditions (platform, visible, notVisible, and true, all re-evaluated before every repeat iteration); onFlowStart/onFlowComplete; repeat with times, while, or both; and retry.',
  'Interactions: tapOn, doubleTapOn, longPressOn, inputText on the focused element, eraseText (up to 10000 characters), openLink, hideKeyboard, basic pressKey, and back; selector targets poll until available and support recursive index, childOf, above, below, leftOf, rightOf, containsChild, containsDescendants, points, and optional; outer command labels are metadata, not target selectors.',
  'Assertions and navigation: assertVisible, assertNotVisible, assertTrue (literal values and ${VAR} lookups only; "", "false", "0", "null", and "undefined" are falsy, everything else is truthy), extendedWaitUntil, scroll, scrollUntilVisible, absolute/percentage/target swipe, takeScreenshot, waitForAnimationToEnd, clearState, stopApp, and killApp (system-initiated process death: am kill on ADB-backed Android devices, which refuse a foreground target with android-kill-requires-background-app — background the app first, for example pressKey: Home — and fail a target whose process survives with android-kill-process-survived; iOS, Limrun, and WebDriver-provider backends run it as stopApp).',
  'Scripts: ordered runScript file/env scripts with http.post, json, and output variables; evalScript inline expressions run flow-scoped JavaScript and write output.* leaves for later steps.',
] as const;

export const MAESTRO_COMPAT_LIMITATIONS = [
  'Permissions: every entry is one settings permission call, applied in order with all first; the step stops at the first entry the selected platform refuses, earlier entries stay applied, and the error names what landed. Android’s only allow level is while-in-use, so location: inuse and location: never mean allow and deny there, while location: always and photos: limited are Apple-only and fail. On iOS, which service a runtime changes is simctl privacy’s own verdict: current runtimes refuse a targeted notifications change and leave notifications untouched under all.',
  'Runtime: iOS and Android only; launchApp.clearState and standalone clearState support Android and iOS simulators, launch arguments are Apple-only (a map-form argument key gains a leading - unless its value is a boolean, as in Maestro), and other standalone device utility/state commands are unsupported.',
  'Expressions: evalScript and condition true: fields (runFlow.when and repeat.while share one evaluator) are evaluated as JavaScript (flow env and prior output leaves are string-typed); a true: field that is a boolean, a maestro.platform comparison, or plain literal text after ${VAR} lookups is decided without JavaScript, with the assertTrue falsy table for literal text. Other fields stay literal or ${VAR} lookup-only — assertTrue supports literals and bare lookups, and other expression-shaped payloads fail loud.',
  'Environment: flow env is the default, AD_VAR_* overrides it, and CLI -e KEY=VALUE wins over both; override keys follow the flow variable grammar (mixed case and dots allowed), and AD_* stays reserved.',
  'Failure diagnostics: resolved targets and runFlow paths are rendered, while inputText payloads remain hidden; do not place secrets in diagnostic identifiers.',
  'Trust: runScript, evalScript, and JavaScript condition true: fields execute flow scripts via node:vm, which is not a security sandbox. runScript runs in a daemon child process with a 30 s script budget. It may make http.post network requests (30 s each, response bodies up to 8 MiB), and its output keys cannot contain a dot. Remote flows refuse runScript before reading its file, including files supplied in the replay bundle, and refuse evalScript and true: fields that need JavaScript. Run these scripts only in trusted local flows. Local runScript paths refer to the daemon filesystem: relative paths resolve from the containing flow, and absolute paths and symlinks are allowed.',
  'Remote screenshots: takeScreenshot uses a daemon-generated path and reports that path in artifactPaths. The flow cannot choose a file destination on the daemon host. Animation waits and tap retry comparisons use temporary screenshots that are removed after comparison.',
  'Errors and tracking: unsupported commands and fields fail with source context when available; open a focused issue only when implementation work is planned.',
] as const;

const MAESTRO_COMPATIBILITY_ADR_URL =
  'https://github.com/callstack/agent-device/blob/main/docs/adr/0015-direct-maestro-engine.md';

const MAESTRO_COMPATIBILITY_ISSUE_URL = 'https://github.com/callstack/agent-device/issues/new';

function formatMaestroCompatibilityReference(): string {
  return [
    'Supported subset:',
    ...MAESTRO_COMPAT_SUPPORTED_CAPABILITIES.map((capability) => `  - ${capability}`),
    '',
    'Boundaries:',
    ...MAESTRO_COMPAT_LIMITATIONS.map((limitation) => `  - ${limitation}`),
  ].join('\n');
}

const maestroReplayBackendDeclaration: ReplayBackendDeclaration<'maestro'> = {
  id: 'maestro',
  package: '@agent-device/maestro',
  help: {
    summary: 'Supported Maestro YAML commands, grammar, and runtime boundaries',
    body: `agent-device help maestro

Install with agent-device plugins add @agent-device/maestro on the client and daemon host. Restart the daemon after installation.

Run Maestro compatibility flows with replay <flow.yaml> --maestro or test <path> --maestro. Bind an iOS or Android target with --platform or an existing session.

${formatMaestroCompatibilityReference()}

Unsupported syntax fails loudly rather than being skipped. Architecture, performance tradeoffs, and declared conformance divergences: ${MAESTRO_COMPATIBILITY_ADR_URL}
Focused compatibility request: ${MAESTRO_COMPATIBILITY_ISSUE_URL}`,
  },
};

/**
 * The engine-free half of every registered replay backend (#3377), as `help` lists it. Kept apart
 * from the registry so reading a declaration adds nothing to the closure of the daemon routes
 * that only load backends. Keys come from the format grammar's vocabulary, and each declaration's
 * `id` is typed to its key, as each plugin's is in the registry, so help cannot describe a backend
 * other than the one its id loads.
 */
const REPLAY_BACKEND_DECLARATIONS: {
  readonly [TId in ReplayFormat]: ReplayBackendDeclaration<TId>;
} = {
  ad: {
    id: 'ad',
    package: '@agent-device/replay',
    help: {
      summary: 'Native .ad replay and test suites (plugin, install separately)',
      body: 'Install agent-device plugins add @agent-device/replay on the daemon host for native .ad replay and all test suites. Existing scripts and arguments stay the same. Ordinary open/close --save-script recording stays in core. Restart the daemon after changing plugins, then retry the original invocation with all its arguments.',
    },
  },
  maestro: maestroReplayBackendDeclaration,
};

export function getReplayBackendDeclaration(
  id: ReplayFormat,
): ReplayBackendDeclaration<ReplayFormat> {
  return REPLAY_BACKEND_DECLARATIONS[id];
}
