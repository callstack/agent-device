export const MAESTRO_COMPAT_SUPPORTED_CAPABILITIES = [
  'Flows: launchApp (with clearState, permissions, and Apple-only launch arguments; permissions apply after state clearing but before launch, and a launchApp without permissions touches nothing — there is no silent all: allow default); setPermissions (mid-flow permission grants, denials, and resets; all resolves in the backend — one simctl call on iOS, the declared permissions on Android — with specific entries overriding after it); runFlow file/inline; runFlow.when and repeat.while conditions (platform, visible, notVisible, and true, all re-evaluated before every repeat iteration); onFlowStart/onFlowComplete; repeat with times, while, or both; and retry.',
  'Interactions: tapOn, doubleTapOn, longPressOn, inputText on the focused element, eraseText, openLink, hideKeyboard, basic pressKey, and back; selector targets poll until available and support recursive index, childOf, above, below, leftOf, rightOf, containsChild, containsDescendants, points, and optional; outer command labels are metadata, not target selectors.',
  'Assertions and navigation: assertVisible, assertNotVisible, assertTrue (literal values and ${VAR} lookups only; "", "false", "0", "null", and "undefined" are falsy, everything else is truthy), extendedWaitUntil, scroll, scrollUntilVisible, absolute/percentage/target swipe, takeScreenshot, waitForAnimationToEnd, clearState, and stopApp.',
  'Scripts: ordered runScript file/env scripts with http.post, json, and output variables; evalScript inline expressions run flow-scoped JavaScript and write output.* leaves for later steps.',
] as const;

export const MAESTRO_COMPAT_LIMITATIONS = [
  'Permissions: every entry is one settings permission call, applied in order with all first; the step stops at the first entry the selected platform refuses, earlier entries stay applied, and the error names what landed. Android’s only allow level is while-in-use, so location: inuse and location: never mean allow and deny there, while location: always and photos: limited are Apple-only and fail. On iOS, which service a runtime changes is simctl privacy’s own verdict: current runtimes refuse a targeted notifications change and leave notifications untouched under all.',
  'Runtime: iOS and Android only; launchApp.clearState and standalone clearState support Android and iOS simulators, launch arguments are Apple-only, and other standalone device utility/state commands are unsupported.',
  'Expressions: evalScript and condition true: fields (runFlow.when and repeat.while share one evaluator) are evaluated as JavaScript (flow env and prior output leaves are string-typed); a true: field that is a boolean, a maestro.platform comparison, or plain literal text after ${VAR} lookups is decided without JavaScript, with the assertTrue falsy table for literal text. Other fields stay literal or ${VAR} lookup-only — assertTrue supports literals and bare lookups, and other expression-shaped payloads fail loud.',
  'Environment: flow env is the default, AD_VAR_* overrides it, and CLI -e KEY=VALUE wins over both.',
  'Failure diagnostics: resolved targets and runFlow paths are rendered, while inputText payloads remain hidden; do not place secrets in diagnostic identifiers.',
  'Trust: runScript, evalScript, and JavaScript condition true: fields execute flow scripts in-process via node:vm, which is not a security sandbox; runScript may make http.post network requests and its output keys cannot contain a dot. evalScript and true: fields that need JavaScript are refused outright for a flow accepted over the daemon’s remote HTTP surface, since that context can escape to the host.',
  'Errors and tracking: unsupported commands and fields fail with source context when available; open a focused issue only when implementation work is planned.',
] as const;

export const MAESTRO_COMPATIBILITY_ADR_URL =
  'https://github.com/callstack/agent-device/blob/main/docs/adr/0015-direct-maestro-engine.md';

export const MAESTRO_COMPATIBILITY_ISSUE_URL =
  'https://github.com/callstack/agent-device/issues/new';

export function formatMaestroCompatibilityReference(): string {
  return [
    'Supported subset:',
    ...MAESTRO_COMPAT_SUPPORTED_CAPABILITIES.map((capability) => `  - ${capability}`),
    '',
    'Boundaries:',
    ...MAESTRO_COMPAT_LIMITATIONS.map((limitation) => `  - ${limitation}`),
  ].join('\n');
}
