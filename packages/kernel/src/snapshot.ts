/**
 * Structured quality verdict computed once by a platform snapshot capture/presentation plan.
 * The daemon renders it; it never re-derives degradation from node shapes.
 *
 * Defined here (the foundational snapshot type module) rather than in
 * snapshot-quality/verdict.ts so SnapshotNode can reference it without a cyclic import;
 * snapshot-quality/verdict.ts owns the validation logic.
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

export type SnapshotQualityVerdict = {
  state: 'healthy' | 'recovered' | 'sparse';
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

/**
 * The snapshot capture family stated ONCE as option key ↔ command-flag key.
 *
 * The same pair (`customActions` ↔ `snapshotCustomActions`, and its seven
 * siblings) used to be re-typed by hand at every seam that carries a snapshot
 * request across the option/flag vocabulary line — the CLI reader, the client
 * option projection, the daemon capture inputs, the presentation key. Each copy
 * restated a fact already stated here and decided nothing, so a new snapshot
 * option cost one edit per seam and a missed seam dropped the option silently.
 *
 * Declared in the kernel because both vocabularies are declared here
 * ({@link SnapshotOptions}) and above (`CommandFlags` in contracts), so this is
 * the lowest point both sides can read. This generalises the shipped
 * `screenshotFlagsFromOptions`/`screenshotOptionsFromFlags` pair for the
 * screenshot family.
 *
 * Every projection takes an EXPLICIT key list: a seam admits the options it
 * routes and no more, so adding a pair here never silently widens a seam that
 * cannot honour it.
 */
// Exported only because the exported types below say `typeof` it.
// fallow-ignore-next-line unused-export
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
  identifier?: string;
  rect?: Rect;
  enabled?: boolean;
  selected?: boolean;
  focused?: boolean;
  /** Native accessibility facts; absent means unavailable, not false. */
  editable?: boolean;
  password?: boolean;
  hintShowing?: boolean;
  /** Accessibility selection offsets, never a character count or proof of value equality. */
  selectionStart?: number;
  selectionEnd?: number;
  visibleToUser?: boolean;
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
} & SnapshotStateProvenance;

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
