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

export type SnapshotPresentationFlagInput = {
  snapshotInteractiveOnly?: boolean;
  snapshotDepth?: number;
  snapshotScope?: string;
  snapshotRaw?: boolean;
  snapshotCustomActions?: boolean;
};

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
  | { backend: 'xctest'; producer: 'apple-runner' | 'appium-source' | 'limrun-ios-tree' }
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
 * The provenance carrier for {@link SnapshotState}: the producer may be absent (legacy states
 * and fixtures predate it), but a present pair still has to come from the
 * {@link SnapshotProvenance} table — the channel may not carry a foreign producer.
 */
export type SnapshotStateProvenance =
  | OptionalProducerProvenance<SnapshotProvenance>
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
  /**
   * Android: the capture is an occluding system surface (notification shade, quick settings)
   * rather than app content. Consumers that surface this tree to the agent must disclose the
   * occlusion (see core/android-system-surface-disclosure.ts).
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

export function attachRefs(nodes: RawSnapshotNode[]): SnapshotNode[] {
  return nodes.map((node, idx) => ({ ...node, ref: `e${idx + 1}` }));
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
  return {
    depth: flags.snapshotDepth,
    interactiveOnly: flags.snapshotInteractiveOnly,
    raw: flags.snapshotRaw,
    scope: flags.snapshotScope,
    customActions: flags.snapshotCustomActions,
  };
}

export function centerOfRect(rect: Rect): Point {
  return {
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
  };
}
