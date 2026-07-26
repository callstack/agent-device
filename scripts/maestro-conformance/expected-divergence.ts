// Declared, intentional divergences between agent-device and upstream Maestro.
// The verifier fails on ANY undeclared divergence, so every entry here is a
// decision on the record rather than silent drift.

export type FlowDivergence = {
  /** Expected non-identical classification for this corpus flow. */
  classification: 'we-reject' | 'mismatch' | 'we-are-lenient';
  /** Why the divergence is intentional. */
  reason: string;
  /** Upstream commands/options our engine deliberately does not support. */
  unsupported?: string[];
  /** Tracking issue, when the divergence is a backlog item rather than a decision. */
  tracking?: string;
};

// Keyed by corpus flow id. Every flow the verifier classifies as `we-reject`,
// `mismatch`, or `we-are-lenient` must appear here; anything undeclared fails the
// mechanical parity record — the list the old hand-typed fixture could not
// produce. `tracking` points at a focused issue only when implementation work is planned.

export const FLOW_DIVERGENCES: Record<string, FlowDivergence> = {
  // --- Unsupported commands (support-matrix decisions) ---
  'upstream/045_clear_keychain': {
    classification: 'we-reject',
    reason: 'Standalone clearKeychain is outside the supported subset.',
    unsupported: ['clearKeychain'],
  },
  'upstream/051_set_location': {
    classification: 'we-reject',
    reason: 'setLocation is outside the supported subset.',
    unsupported: ['setLocation'],
  },
  'upstream/062_copy_paste_text': {
    classification: 'we-reject',
    reason: 'Clipboard commands are unsupported; pasteText is de-advertised (takes clipboard, not inline text).',
    unsupported: ['copyTextFrom', 'pasteText'],
  },
  'upstream/067_assertTrue_pass': {
    classification: 'we-reject',
    reason: 'assertTrue is outside the current subset; this flow requires a JavaScript expression.',
    unsupported: ['assertTrue'],
    tracking: 'https://github.com/callstack/agent-device/issues/1292',
  },
  'upstream/090_travel': {
    classification: 'we-reject',
    reason: 'travel is outside the supported subset.',
    unsupported: ['travel'],
  },
  'upstream/116_kill_app': {
    classification: 'we-reject',
    reason: 'Standalone killApp is outside the supported subset.',
    unsupported: ['killApp'],
  },
  'upstream/131_setPermissions': {
    classification: 'we-reject',
    reason: 'Standalone setPermissions is outside the supported subset.',
    unsupported: ['setPermissions'],
  },
  'upstream/053_repeat_times': {
    classification: 'we-reject',
    reason: 'repeat is supported, but the flow also uses evalScript and a ${output.list.length} times expression.',
    unsupported: ['evalScript'],
  },
  // --- Deliberately stricter than upstream ---
  'invalid/duplicate-keys': {
    classification: 'we-reject',
    reason:
      'Upstream (SnakeYAML) silently accepts duplicate mapping keys and keeps the last one; our parser rejects them. Being stricter than upstream on a near-certain authoring mistake is intentional — surfacing it beats silently dropping a selector the author wrote.',
    unsupported: ['duplicate YAML mapping keys'],
  },
  // --- Unsupported options on supported commands (parity gaps) ---
  'upstream/032_element_index': {
    classification: 'we-reject',
    reason:
      'tapOn.index supports ${VAR} lookup; the flow uses a ${0 + 1} JS expression, which is not supported.',
    unsupported: ['tapOn.index (JS expression)'],
    tracking: 'https://github.com/callstack/agent-device/issues/1292',
  },
  'upstream/034_press_key': {
    classification: 'we-reject',
    reason: 'pressKey supports back/enter/home/return; the flow exercises ~30 Android/TV keycodes.',
    unsupported: ['pressKey (extended keycodes)'],
  },
  'upstream/076_optional_assertion': {
    classification: 'we-reject',
    reason: 'assertTrue is outside the supported subset; optional is now supported on scrollUntilVisible and extendedWaitUntil.',
    unsupported: ['assertTrue'],
    tracking: 'https://github.com/callstack/agent-device/issues/1295',
  },
  'upstream/079_scroll_until_visible': {
    classification: 'we-reject',
    reason: 'scrollUntilVisible is supported; the flow sets the unsupported speed and visibilityPercentage options.',
    unsupported: ['scrollUntilVisible.speed', 'scrollUntilVisible.visibilityPercentage'],
  },
  'upstream/101_doubleTapOn': {
    classification: 'we-reject',
    reason: 'doubleTapOn is supported; the flow sets the unsupported retryTapIfNoChange option on it.',
    unsupported: ['doubleTapOn.retryTapIfNoChange'],
  },
  'upstream/119_retry_commands': {
    classification: 'we-reject',
    reason: 'retry is supported; the flow uses the unsupported per-command waitToSettleTimeoutMs option on a nested tapOn.',
    unsupported: ['tapOn.waitToSettleTimeoutMs'],
  },
  // --- agent-device supports ${VAR} in integer-typed numeric option fields that the pinned upstream parser rejects ---
  'authored/numeric-variable-tap': {
    classification: 'we-are-lenient',
    reason:
      'agent-device supports ${VAR} lookup in tapOn.index/repeat/delay; the pinned upstream Maestro 2.5.1 parser only accepts ${VAR} in tapOn.index (string-typed) and rejects repeat/delay as integer-typed.',
  },
  'authored/numeric-variable-doubletap': {
    classification: 'we-are-lenient',
    reason:
      'agent-device supports ${VAR} lookup in doubleTapOn.delay; the pinned upstream Maestro 2.5.1 parser rejects it as integer-typed.',
  },
  'authored/numeric-variable-swipe': {
    classification: 'we-are-lenient',
    reason:
      'agent-device supports ${VAR} lookup in swipe.duration; the pinned upstream Maestro 2.5.1 parser rejects it as integer-typed.',
  },
  'authored/numeric-variable-erase': {
    classification: 'we-are-lenient',
    reason:
      'agent-device supports ${VAR} lookup in eraseText.charactersToErase; the pinned upstream Maestro 2.5.1 parser rejects it as integer-typed.',
  },
};

// Layer-2 semantic vectors that describe an upstream constant we intentionally
// do NOT mirror (they document a deviation rather than a value to match).
export const LAYER2_REFERENCE_ONLY = new Set<string>([
  // Upstream iOS taps wait up to 3s for the screen to become static BEFORE
  // tapping (IOSDriver.SCREEN_SETTLE_TIMEOUT_MS). agent-device deliberately omits
  // this pre-tap gate and masks entrance-animation flake with quantized-signature
  // retryIfNoChange instead. See ADR-0015.
  'iosScreenSettleTimeoutMs',
]);

// Supported commands that no corpus flow exercises and are therefore verified by
// other means (or explicitly deferred). Listed so coverage stays honest.
export const UNVERIFIED_COMMANDS = new Set<string>([]);

// Behavioral deviations that are decisions, not parser-level mismatches. These
// are not tied to a single corpus flow; they are recorded so the support matrix
// and ADR-0015 stay in sync with the oracle.
export type DocumentedDeviation = {
  id: string;
  area: string;
  description: string;
};

export const DOCUMENTED_DEVIATIONS: DocumentedDeviation[] = [
  {
    id: 'animation-wait-mechanism',
    area: 'waitForAnimationToEnd',
    description:
      'Upstream waitForAnimationToEnd diffs full-screen screenshots; agent-device diffs a typed-hierarchy signature and only falls back to the screenshot metric. The 0.005 threshold and 15000ms timeout constants match (layer-2 crosscheck); the stabilization mechanism differs by design.',
  },
  {
    id: 'horizontal-swipe-presets',
    area: 'swipe',
    description:
      'Vertical directional swipes use the upstream 0.1/0.9 edge fractions; horizontal directional swipes route through the shared in-page gesture planner to avoid triggering the OS interactive-back edge gesture.',
  },
  {
    id: 'condition-poll-as-stabilization',
    area: 'settle',
    description:
      'Upstream settle busy-polls after gestures; agent-device folds condition polling into the same settle protocol (execute drains a stability barrier, observe condition-polls).',
  },
  {
    id: 'ambiguity-strictness-under-optional',
    area: 'optional',
    description:
      'Upstream target resolution selects the first match and never raises ambiguity. agent-device keeps first-match parity for Maestro selectors, but AMBIGUOUS_MATCH surfacing from nested shared public commands is non-suppressible under optional (policy-layer strictness, not an upstream-parity vector).',
  },
  {
    id: 'ios-pre-tap-static-gate-omitted',
    area: 'tap',
    description:
      'agent-device omits the upstream iOS 3s pre-tap static-screen gate (IOSDriver.SCREEN_SETTLE_TIMEOUT_MS); see LAYER2_REFERENCE_ONLY.',
  },
];
