export const MAESTRO_COMPAT_SUPPORTED_CAPABILITIES = [
  'Flows: launchApp; runFlow file/inline with platform, visibility, and limited boolean conditions; onFlowStart/onFlowComplete; repeat.times and retry.',
  'Interactions: tapOn, doubleTapOn, longPressOn, inputText, eraseText, openLink, hideKeyboard, basic pressKey, and back; targets support index, childOf, label, points, and optional.',
  'Assertions and navigation: assertVisible, assertNotVisible, extendedWaitUntil, scroll, scrollUntilVisible, absolute/percentage/target swipe, takeScreenshot, waitForAnimationToEnd, and stopApp.',
  'Scripts: ordered runScript file/env scripts with http.post, json, and output variables.',
] as const;

export const MAESTRO_COMPAT_LIMITATIONS = [
  'Runtime: iOS and Android only; launchApp.clearState supports Android and iOS simulators, launch arguments are Apple-only, and standalone device utility/state commands are unsupported.',
  'Expressions: when.true supports boolean literals and maestro.platform comparisons; repeat.while, evalScript, and broader JavaScript expressions are unsupported.',
  'Environment: flow env is the default, AD_VAR_* overrides it, and CLI -e KEY=VALUE wins over both.',
  'Trust: runScript executes trusted scripts, may make http.post network requests, and is not a security sandbox; output keys cannot contain a dot.',
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
