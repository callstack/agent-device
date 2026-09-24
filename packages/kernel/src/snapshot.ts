/**
 * Structured quality verdict computed once by a platform snapshot capture/presentation plan.
 * The daemon renders it; it never re-derives degradation from node shapes.
 *
 * Defined here (the foundational snapshot type module) rather than in
 * capture-kit's snapshot-quality-verdict.ts so SnapshotNode can reference it without a cyclic
 * import. Ownership splits three ways: this module owns the vocabularies below, capture-kit parses
 * an untrusted runner payload into them, and contracts re-hydrates a verdict this repo published.
 */
/**
 * Which capture STRATEGY produced a snapshot, within one platform's plan —
 * distinct from `SnapshotBackend`, which names the platform channel
 * (`xctest`/`android`/…). A platform plan may change strategy mid-sequence, and two strategies do
 * not return comparable views of one screen (#1569). Android's helper presentation is included
 * here so its quality verdict uses the same typed contract as the iOS strategy chain.
 */
export type SnapshotCaptureBackend = 'tree' | 'queries' | 'private-ax' | 'android-helper';

/** Internal backends that evidence probes may select explicitly. */
export type SnapshotPreferredBackend = 'tree' | 'private-ax';

export type SnapshotQualityTiming = {
  acquisitionMs: number;
  presentationMs: number;
};

/**
 * The verdict states a capture plan may stamp. This tuple is the ONE declaration of that
 * vocabulary, and `SnapshotQualityVerdict['state']` is its projection; readers hold exhaustive maps
 * over the union instead of importing this module, because the eager-closure gate freezes their
 * loading shape (#2872). This tuple and the Apple runner's `SnapshotQualityState.allCases` are each
 * pinned as a set to `contracts/fixtures/ios-snapshot-quality-states.json`, so a state one side
 * renames, adds, or deletes without the other goes red there instead of arriving as a verdict the
 * host cannot name — which reads as verdict-absent and drops the disclosure with it.
 */
export const SNAPSHOT_QUALITY_STATES = ['healthy', 'recovered', 'sparse'] as const;

export type SnapshotQualityState = (typeof SNAPSHOT_QUALITY_STATES)[number];

export type SnapshotQualityVerdict = {
  state: SnapshotQualityState;
  backend: SnapshotCaptureBackend;
  reason?: string;
  // 'deferred' = the penalty circuit breaker pre-selected a non-XCTest backend; nothing new
  // degraded on THIS capture (no repeated warning, no settle budget reset).
  // 'requested-backend' = the REQUEST pre-selected it (e.g. `snapshot --actions`,
  // which only the private-AX backend can serve). Nothing degraded at all, so it
  // must never surface as a degradation — not even through the one-shot latch
  // that exists to catch internally-armed penalties.
  reasonCode?:
    | 'ax-rejected'
    | 'sparse-tree'
    | 'budget'
    | 'no-nodes'
    | 'capture-failed'
    | 'presentation-failed'
    | 'deferred'
    | 'requested-backend';
  effectiveDepth?: number;
  collapsedLeafIndexes?: number[];
  /**
   * Coverage of an opt-in custom-action pass (`snapshot --actions`): how many
   * merged elements were eligible and how many the bounded pass reached. An
   * unread element is indistinguishable from one with no actions, so a partial
   * pass has to be disclosed rather than left to look complete.
   */
  customActions?: { read: number; candidates: number; truncated: number; blocked: boolean };
  /** Response-level phase timing for the backend named by `backend`. */
  timing?: SnapshotQualityTiming;
};

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Point = {
  x: number;
  y: number;
};

export type SnapshotOptions = {
  interactiveOnly?: boolean;
  depth?: number;
  scope?: string;
  raw?: boolean;
  /**
   * Internal (never CLI-exposed): capture with this backend first regardless of
   * channel health. Evidence comparisons are only valid same-backend (backends
   * are not comparable views of a screen), so a corroboration probe must be
   * captured the way its baseline was.
   */
  preferredBackend?: SnapshotPreferredBackend;
  /**
   * Read accessibility custom actions for elements that merge their children
   * away. Opt-in because each such element costs its own accessibility round
   * trip; see `RawSnapshotNode.actions`.
   */
  customActions?: boolean;
};

// The snapshot capture family stated ONCE as option key ↔ command-flag key.
//
// The same pair (`customActions` ↔ `snapshotCustomActions`, and its seven
// siblings) used to be re-typed by hand at every seam that carries a snapshot
// request across the option/flag vocabulary line — the CLI reader, the client
// option projection, the daemon capture inputs, the presentation key. Each copy
// restated a fact already stated here and decided nothing, so a new snapshot
// option cost one edit per seam and a missed seam dropped the option silently.
//
// Declared in the kernel because both vocabularies are declared here
// (SnapshotOptions) and above (`CommandFlags` in contracts), so this is
// the lowest point both sides can read. This generalises the shipped
// `screenshotFlagsFromOptions`/`screenshotOptionsFromFlags` pair for the
// screenshot family.
//
// Every projection takes an EXPLICIT key list: a seam admits the options it
// routes and no more, so adding a pair here never silently widens a seam that
// cannot honour it.
//
// Exported only because the exported types below say `typeof` it — this const
// is not itself public API, so the rationale stays a source comment (stripped
// from the published .d.ts) instead of a bundled JSDoc block.
/** The CLI/daemon flag key for each snapshot capture option, by option name. */
export const SNAPSHOT_OPTION_FLAGS = {
  interactiveOnly: 'snapshotInteractiveOnly',
  depth: 'snapshotDepth',
  scope: 'snapshotScope',
  raw: 'snapshotRaw',
  customActions: 'snapshotCustomActions',
  forceFull: 'snapshotForceFull',
  includeHiddenContentHints: 'snapshotIncludeHiddenContentHints',
  preferredBackend: 'snapshotPreferredBackend',
} as const;

export type SnapshotOptionKey = keyof typeof SNAPSHOT_OPTION_FLAGS;

type SnapshotOptionValues = {
  interactiveOnly: boolean;
  depth: number;
  scope: string;
  raw: boolean;
  customActions: boolean;
  forceFull: boolean;
  includeHiddenContentHints: boolean;
  preferredBackend: SnapshotPreferredBackend;
};

/** The option-vocabulary view of the declared pairs, narrowed to `TKeys`. */
export type SnapshotOptionFields<TKeys extends SnapshotOptionKey = SnapshotOptionKey> = {
  [TKey in TKeys]?: SnapshotOptionValues[TKey];
};

/** The flag-vocabulary view of the declared pairs, narrowed to `TKeys`. */
export type SnapshotOptionFlagFields<TKeys extends SnapshotOptionKey = SnapshotOptionKey> = {
  [TKey in TKeys as (typeof SNAPSHOT_OPTION_FLAGS)[TKey]]?: SnapshotOptionValues[TKey];
};

/**
 * Option keys a `snapshot`/`diff` command request carries end to end. `scope` is
 * resolved against the session before capture, so seams that resolve it spread
 * this projection and then override that one key.
 */
export const SNAPSHOT_COMMAND_OPTION_KEYS = [
  'interactiveOnly',
  'depth',
  'scope',
  'raw',
  'customActions',
  'forceFull',
] as const;

/**
 * The snapshot capture options a `snapshot`/`diff` request is stated in, in
 * every vocabulary that names them: the public SDK type, the internal request
 * bag and the command runtime options each reference THIS type instead of
 * re-listing the same six keys.
 */
export type SnapshotCommandOptionFields = SnapshotOptionFields<
  (typeof SNAPSHOT_COMMAND_OPTION_KEYS)[number]
>;

/** Option keys a daemon runtime capture input carries; `forceFull` is a command-level concern. */
export const SNAPSHOT_CAPTURE_OPTION_KEYS = [
  'interactiveOnly',
  'preferredBackend',
  'depth',
  'scope',
  'raw',
  'customActions',
  'includeHiddenContentHints',
] as const;

/** Option keys that identify a presentation; see {@link buildSnapshotPresentationKey}. */
// fallow-ignore-next-line unused-export
export const SNAPSHOT_PRESENTATION_OPTION_KEYS = [
  'depth',
  'interactiveOnly',
  'raw',
  'scope',
  'customActions',
] as const;

/**
 * Reads the declared options out of a flags bag. Every requested key is present
 * (possibly `undefined`), matching what the hand-written copies produced.
 */
export function snapshotOptionsFromFlags<const TKeys extends readonly SnapshotOptionKey[]>(
  flags: SnapshotOptionFlagFields | undefined,
  keys: TKeys,
): SnapshotOptionFields<TKeys[number]> {
  return Object.fromEntries(
    keys.map((key) => [key, flags?.[SNAPSHOT_OPTION_FLAGS[key]]]),
  ) as SnapshotOptionFields<TKeys[number]>;
}

/** Writes the declared options back into flag vocabulary, dropping absent values. */
export function snapshotFlagsFromOptions<const TKeys extends readonly SnapshotOptionKey[]>(
  options: SnapshotOptionFields | undefined,
  keys: TKeys,
): SnapshotOptionFlagFields<TKeys[number]> {
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = options?.[key];
      return value === undefined ? [] : [[SNAPSHOT_OPTION_FLAGS[key], value]];
    }),
  ) as SnapshotOptionFlagFields<TKeys[number]>;
}

export type SnapshotPresentationFlagInput = SnapshotOptionFlagFields<
  (typeof SNAPSHOT_PRESENTATION_OPTION_KEYS)[number]
>;

export type RawSnapshotNode = {
  index: number;
  type?: string;
  role?: string;
  subrole?: string;
  label?: string;
  value?: string;
  /**
   * Android content description when it is not already the `label`. An Android node is
   * labelled by its text and falls back to the content description only when it has none,
   * so an accessibility label the app set beside visible text (a labelled text view, a
   * filled or hinted field) is carried here for consumers that want the accessible name.
   */
  contentDescription?: string;
  identifier?: string;
  rect?: Rect;
  enabled?: boolean;
  selected?: boolean;
  /** Checked state of a checkable control (switch, checkbox, radio); absent means not checkable or unavailable. */
  checked?: boolean;
  focused?: boolean;
  /** Accessibility heading flag an app set on the node; absent means not a heading or unavailable. */
  heading?: boolean;
  /** Localized role description an app set beside the native class, verbatim (`Tab`, `Tab List`, `Link`). */
  roleDescription?: string;
  /** Native accessibility facts; absent means unavailable, not false. */
  editable?: boolean;
  password?: boolean;
  hintShowing?: boolean;
  /**
   * Placeholder text of a text field (the Android hint), whether or not the field is showing it.
   * Absent when the field has none or the producer did not read it.
   */
  placeholder?: string;
  /** Accessibility selection offsets, never a character count or proof of value equality. */
  selectionStart?: number;
  selectionEnd?: number;
  visibleToUser?: boolean;
  /** UIKit `isUserInteractionEnabled`; absent means the producer did not read it, not false. */
  userInteractionEnabled?: boolean;
  hittable?: boolean;
  depth?: number;
  parentIndex?: number;
  pid?: number;
  bundleId?: string;
  appName?: string;
  windowTitle?: string;
  surface?: string;
  hiddenContentAbove?: boolean;
  hiddenContentBelow?: boolean;
  interactionBlocked?: 'covered';
  presentationHints?: string[];
  /**
   * Backend-minted ref for this node, when the capture backend already assigns a
   * stable, actionable ref (e.g. the web/agent-browser backend resolves actions
   * against its own `@eN` refs). `attachRefs` preserves this instead of re-minting
   * a dense positional ref, so the ref an agent sees in the snapshot is the same
   * ref the backend can resolve on the next action. Absent for backends that do
   * not mint refs — those fall back to dense `e${index}` numbering.
   */
  ref?: string;
  /**
   * Accessibility custom actions the element exposes (iOS
   * `UIAccessibilityCustomAction`, React Native `accessibilityActions`). Merged
   * cards publish their real affordances here instead of as child elements, so
   * this is often the only evidence that a collapsed node has any. Populated by
   * opt-in captures only — see `snapshot --actions`.
   */
  actions?: string[];
};

export type HiddenContentHint = {
  hiddenContentAbove?: true;
  hiddenContentBelow?: true;
};

/**
 * What a capture's producer can say about the software keyboard on screen, measured while the tree
 * was captured rather than rebuilt from it afterwards.
 *
 * A keyboard is its own system surface, so it never reaches the tree as a covering sibling of app
 * content, and a consumer that wants to refuse a tap behind it has to learn where it is from
 * somewhere (#2589). A producer that can measure the band directly — the Apple runner, from its
 * `app.keyboards` query — publishes one fact per capture and says nothing else about it. A consumer therefore gets three
 * answers and no fourth: a band in the same space as every node rect, a proven absence, or a
 * producer that could not look.
 *
 * A producer that publishes nothing has declared nothing, so absence from a result means the same
 * thing as `unmeasurable` — which is why the field stays optional on every carrier, including the
 * three client-side paths that rebuild a state from a bare backend result (#2199). Those consumers
 * then derive the band from the tree they hold: the rule that stays for the producers that publish
 * no fact (#2660).
 */
export type SnapshotKeyboardBandFact =
  /** The band the keyboard occupies, in the same orientation space as this capture's node rects. */
  | { kind: 'visible'; frame: Rect }
  /** The producer looked for the keyboard and found none. */
  | { kind: 'absent' }
  /**
   * The producer cannot measure the band on this path, with a stable reason code. Typed rather than
   * inferred from absence so a log says which path failed to measure without the consumer having to
   * guess which producer it was talking to.
   */
  | { kind: 'unmeasurable'; reason: string };

export type SnapshotNode = RawSnapshotNode & {
  ref: string;
  /**
   * Output-only marker set by client-serialization dedup (see
   * ../snapshot/snapshot-label-dedup.ts) when `label`/`identifier` was omitted
   * because it string-equals the nearest ancestor's value in the parent chain.
   * Never set on the in-daemon session tree used by selectors/wait/replay.
   */
  inheritsLabel?: true;
  inheritsIdentifier?: true;
};

/**
 * The channel↔producer pairs that can actually occur. One channel is fed by several producers
 * with different guarantees: `xctest` trees come from the local Apple runner, Appium
 * page-source XML, or a limrun element tree, and only the runner's output has been through the
 * runner's presentation (clip fold, effective geometry, scope). Logic that assumes
 * presentation, scope, or geometry guarantees must key on the producer, never on the channel
 * alone.
 *
 * This table is the single owner of both vocabularies: the platform channel
 * (`SnapshotBackend` is its `backend` projection) and the acquisition producer (the third
 * axis beside the channel and the in-plan capture strategy `SnapshotCaptureBackend`). Every
 * carrier embeds the pair atomically — a cross-channel pair does not compile (pinned by
 * snapshot-provenance.test.ts).
 */
export type SnapshotProvenance =
  | {
      backend: 'xctest';
      producer: 'apple-runner' | 'simulator-ax-bridge' | 'appium-source' | 'limrun-ios-tree';
    }
  | { backend: 'android'; producer: 'android-uiautomator' | 'appium-source' }
  | { backend: 'harmonyos-arkui'; producer: 'harmonyos-uitest' }
  | { backend: 'macos-helper'; producer: 'macos-helper' }
  | { backend: 'linux-atspi'; producer: 'linux-atspi' }
  | { backend: 'web'; producer: 'agent-browser' };

export type SnapshotBackend = SnapshotProvenance['backend'];

type OptionalProducerProvenance<Pair> = Pair extends {
  backend: infer Backend;
  producer: infer Producer;
}
  ? { backend: Backend; producer?: Producer }
  : never;

/**
 * The provenance carrier for {@link SnapshotState}: the producer may be absent (a client-side
 * fallback that rebuilds a state from a bare backend result knows the channel and nothing more),
 * but a present pair still has to come from the {@link SnapshotProvenance} table — the channel
 * may not carry a foreign producer.
 */
export type SnapshotStateProvenance =
  | OptionalProducerProvenance<SnapshotProvenance>
  | { backend?: undefined; producer?: undefined };

/**
 * The provenance a capture hands to the daemon snapshot assembly: either nothing is known about
 * the origin, or the WHOLE pair is. A channel that arrived without its producer would leave the
 * assembly guessing who presented the tree, which is exactly the backend-name presentation
 * policy #2199 deleted — so it does not compile. Every production capture satisfies this: the
 * interactor boundary (`SnapshotResult`) already carries {@link SnapshotProvenance}.
 */
export type SnapshotCaptureProvenance =
  | SnapshotProvenance
  | { backend?: undefined; producer?: undefined };

/**
 * Narrows a provenance-carrying value to just its pair without decorrelating the two fields
 * (reading `backend` and `producer` separately would lose the pairing for the type system).
 */
export function snapshotStateProvenance(
  value: SnapshotStateProvenance | undefined,
): SnapshotStateProvenance {
  if (value === undefined || value.backend === undefined) return {};
  switch (value.backend) {
    case 'xctest':
      return { backend: value.backend, producer: value.producer };
    case 'android':
      return { backend: value.backend, producer: value.producer };
    case 'harmonyos-arkui':
      return { backend: value.backend, producer: value.producer };
    case 'macos-helper':
      return { backend: value.backend, producer: value.producer };
    case 'linux-atspi':
      return { backend: value.backend, producer: value.producer };
    case 'web':
      return { backend: value.backend, producer: value.producer };
  }
}

export function isSnapshotBackend(value: unknown): value is SnapshotBackend {
  return (
    value === 'xctest' ||
    value === 'android' ||
    value === 'harmonyos-arkui' ||
    value === 'macos-helper' ||
    value === 'linux-atspi' ||
    value === 'web'
  );
}

export function usesMobileSnapshotPresentation(backend: SnapshotBackend | undefined): boolean {
  return (
    backend === undefined ||
    backend === 'xctest' ||
    backend === 'android' ||
    backend === 'harmonyos-arkui'
  );
}

/**
 * Reasons the Apple runner can stamp when serving a command required re-activating the session app
 * (#2682). Mirrors its `activateTarget(bundleId:reason:)` call sites.
 */
export const IOS_TARGET_ACTIVATION_REASONS = [
  'bundle_changed',
  'stale_target',
  'missing_after_wait',
  'interaction_foreground_guard',
] as const;

export type IosTargetActivationReason = (typeof IOS_TARGET_ACTIVATION_REASONS)[number];

/** Whether `value` is a reason the runner can stamp; the only gate consumers apply to the field. */
export function isIosTargetActivationReason(value: unknown): value is IosTargetActivationReason {
  return (
    typeof value === 'string' &&
    (IOS_TARGET_ACTIVATION_REASONS as readonly string[]).includes(value)
  );
}

/**
 * States an activation could have been needed for, in `XCApplicationState` raw order: unknown 0,
 * notRunning 1, suspended 2, plain background 3 — the SDK declares suspended on non-macOS platforms
 * only. `runningForeground` is excluded because the runner skips `activate()` when the app is already
 * foreground and never stamps a fact there. The decoder, which assigns raw values, is what keeps this
 * order honest.
 */
export const IOS_TARGET_ACTIVATION_PRIOR_STATES = [
  'unknown',
  'notRunning',
  'runningBackgroundSuspended',
  'runningBackground',
] as const;

export type IosTargetActivationPriorState = (typeof IOS_TARGET_ACTIVATION_PRIOR_STATES)[number];

/**
 * How XCTest reports an app running (`XCUIApplication.State`): the prior states above plus the
 * foreground state the activation disclosure never carries. The `appState` runner command names
 * the session app's state with these words.
 */
export const APPLE_APPLICATION_STATES = [
  ...IOS_TARGET_ACTIVATION_PRIOR_STATES,
  'runningForeground',
] as const;

export type AppleApplicationState = (typeof APPLE_APPLICATION_STATES)[number];

export function isAppleApplicationState(value: unknown): value is AppleApplicationState {
  return (
    typeof value === 'string' && (APPLE_APPLICATION_STATES as readonly string[]).includes(value)
  );
}

/**
 * Foreground repair the Apple runner performed while serving one command (#2682). `priorState` is
 * the session app's state BEFORE the runner activated it, so the fact describes what was repaired
 * rather than what the repair produced. `otherActiveApplicationPid` is present only when exactly one
 * application other than the session app held an active accessibility session at that moment: a
 * liveness claim and nothing more, since the private AX client reports no ordering of
 * `activeApplications`, resolves pids only, and answers no bundle id for an arbitrary app.
 */
export type IosTargetActivation = Readonly<{
  reason: IosTargetActivationReason;
  priorState: IosTargetActivationPriorState;
  otherActiveApplicationPid?: number;
}>;

export type SnapshotState = {
  nodes: SnapshotNode[];
  createdAt: number;
  truncated?: boolean;
  snapshotQuality?: SnapshotQualityVerdict;
  comparisonSafe?: boolean;
  presentationKey?: string;
  /** Opaque equality key for iOS acquisition and presentation lineage. */
  comparisonKey?: string;
  /**
   * Android: the capture is an occluding system surface (notification shade, quick settings)
   * rather than app content. Consumers that surface this tree to the agent must disclose the
   * occlusion (see `@agent-device/contracts/android-system-surface-disclosure`).
   */
  systemSurfaceOnly?: boolean;
  /**
   * iOS: the bundle id of the in-place system surface this capture describes (a web sign-in sheet
   * presented over the app, #2438). Two captures that disagree here describe different surfaces and
   * must never be compared as the same presentation; consumers that surface the tree disclose it.
   */
  iosSystemSurfaceBundleId?: string;
  /**
   * iOS: the keyboard band this capture's producer measured, when it measured one. The tap-path
   * keyboard guard prefers this over the band it would otherwise derive from `nodes`, because a
   * producer that can query the keyboard directly answers in the app's own orientation space and
   * needs no geometry to be plausible (#2660). Absent means the guard measures the tree as before.
   */
  keyboard?: SnapshotKeyboardBandFact;
  /**
   * iOS: this capture's own command found the session app out of foreground and the runner
   * activated it before answering, so an earlier observation in the session described whatever held
   * the foreground instead (#2682). Consumers that surface this tree disclose the repair.
   */
  targetActivation?: IosTargetActivation;
  /** What post-gesture stabilization proved about the gesture before this capture. */
  postGestureOutcome?: PostGestureOutcome;
} & SnapshotStateProvenance;

/** The gesture a post-gesture outcome fact names: the command and its positionals. */
export type PostGestureAction = { action: string; positionals: string[] };

/**
 * `unsettled`: the surface was still changing when the stabilization deadline expired.
 * `no-effect`: the settled surface still matches the pre-gesture tree (#1600).
 */
export type PostGestureOutcome = {
  kind: 'unsettled' | 'no-effect';
  gesture: PostGestureAction;
};

/**
 * A capture taken at once to recover or widen `previous` reads the same moment after the same
 * gesture, so it carries that capture's outcome.
 */
export function inheritPostGestureOutcome<T extends SnapshotState>(
  previous: SnapshotState,
  recapture: T,
): T {
  recapture.postGestureOutcome ??= previous.postGestureOutcome;
  return recapture;
}

export type SnapshotUnchanged = {
  ageMs: number;
  nodeCount: number;
  interactiveOnly?: boolean;
  scope?: string;
};

export type SnapshotVisibilityReason =
  | 'offscreen-nodes'
  | 'scroll-hidden-above'
  | 'scroll-hidden-below';

export type SnapshotVisibility = {
  partial: boolean;
  visibleNodeCount: number;
  totalNodeCount: number;
  reasons: SnapshotVisibilityReason[];
};

export type ScreenshotOverlayRef = {
  ref: string;
  label?: string;
  rect: Rect;
  overlayRect: Rect;
  center: Point;
};

/**
 * Assign a display ref to every node. A node that already carries a backend-minted
 * `ref` keeps it (see `RawSnapshotNode.ref`) — the web/agent-browser backend resolves
 * actions against its own refs, so re-minting a dense positional ref here would make
 * the snapshot show one ref while actions act on a different element. Backends that do
 * not mint refs get dense `e${index}` numbering, matching the historical behavior.
 */
export function attachRefs(nodes: RawSnapshotNode[]): SnapshotNode[] {
  return nodes.map((node, idx) => ({ ...node, ref: node.ref ?? `e${idx + 1}` }));
}

/**
 * Versioned-ref grammar (#1076): a ref argument may carry an optional
 * `~s<generation>` suffix pinning it to the session snapshot generation that
 * minted it, e.g. `@e12~s3`. The suffix is accepted INPUT only — snapshot
 * output stays plain `e12` refs (the tree is the most token-expensive artifact
 * agents consume), and ref-issuing responses carry the generation ONCE as the
 * additive `refsGeneration` field.
 */
const REF_GENERATION_SUFFIX_RE = /^~s(\d+)$/;

export const REF_GRAMMAR_HINT =
  'Refs look like @e12, optionally pinned to the snapshot generation that minted them: @e12~s3 (the ref, then "~s" and the refsGeneration reported by the issuing snapshot/find response).';

export type SplitRef = { base: string; generation?: number };

/**
 * Split an optional `~s<generation>` suffix off a ref token (`@e12~s3` or bare
 * `e12~s3`). `base` keeps the token's `@` prefix (or lack of one). Returns null
 * when a `~` is present but the suffix does not match the grammar — callers
 * surface INVALID_ARGS with REF_GRAMMAR_HINT.
 */
export function splitRefGenerationSuffix(input: string): SplitRef | null {
  const trimmed = input.trim();
  const tildeIndex = trimmed.indexOf('~');
  if (tildeIndex === -1) return { base: trimmed };
  const match = REF_GENERATION_SUFFIX_RE.exec(trimmed.slice(tildeIndex));
  if (!match || tildeIndex === 0) return null;
  return { base: trimmed.slice(0, tildeIndex), generation: Number(match[1]) };
}

export function normalizeRef(input: string): string | null {
  // Node lookup always uses the plain ref; the generation suffix is stripped
  // here so every existing parse site accepts the pinned form (#1076).
  const split = splitRefGenerationSuffix(input);
  if (!split) return null;
  const trimmed = split.base;
  if (trimmed.startsWith('@')) {
    const ref = trimmed.slice(1);
    return ref ? ref : null;
  }
  if (trimmed.startsWith('e')) return trimmed;
  return null;
}

export function findNodeByRef(nodes: SnapshotNode[], ref: string): SnapshotNode | null {
  return nodes.find((node) => node.ref === ref) ?? null;
}

export function buildSnapshotPresentationKey(flags: SnapshotOptions | undefined): string {
  return JSON.stringify({
    interactiveOnly: flags?.interactiveOnly === true,
    depth: typeof flags?.depth === 'number' ? flags.depth : null,
    scope: flags?.scope?.trim() || null,
    raw: flags?.raw === true,
    // A capture that asked for custom actions is not the same presentation as
    // one that did not: without this, 'snapshot' then 'snapshot --actions' on a
    // still screen reports 'unchanged' and never delivers what was asked for.
    customActions: flags?.customActions === true,
  });
}

export function snapshotPresentationOptionsFromFlags(
  flags: SnapshotPresentationFlagInput | undefined,
): SnapshotOptions | undefined {
  if (!flags) return undefined;
  return snapshotOptionsFromFlags(flags, SNAPSHOT_PRESENTATION_OPTION_KEYS);
}

export function centerOfRect(rect: Rect): Point {
  return {
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
  };
}
