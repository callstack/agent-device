/**
 * Structured quality verdict computed once by the iOS runner's snapshot capture plan.
 * The daemon renders it; it never re-derives degradation from node shapes.
 *
 * Defined here (the foundational snapshot type module) rather than in
 * snapshot-quality.ts so SnapshotNode can reference it without a cyclic import;
 * snapshot-quality.ts (the validation logic) re-exports it for existing callers.
 */
export type SnapshotQualityVerdict = {
  state: 'healthy' | 'recovered' | 'sparse';
  backend: 'tree' | 'queries' | 'private-ax';
  reason?: string;
  reasonCode?: 'ax-rejected' | 'sparse-tree' | 'budget' | 'no-nodes' | 'capture-failed';
  effectiveDepth?: number;
  collapsedLeafIndexes?: number[];
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
};

export type SnapshotPresentationFlagInput = {
  snapshotInteractiveOnly?: boolean;
  snapshotDepth?: number;
  snapshotScope?: string;
  snapshotRaw?: boolean;
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

export type SnapshotBackend = 'xctest' | 'android' | 'macos-helper' | 'linux-atspi' | 'web';

export function isSnapshotBackend(value: unknown): value is SnapshotBackend {
  return (
    value === 'xctest' ||
    value === 'android' ||
    value === 'macos-helper' ||
    value === 'linux-atspi' ||
    value === 'web'
  );
}

export function usesMobileSnapshotPresentation(backend: SnapshotBackend | undefined): boolean {
  return backend === undefined || backend === 'xctest' || backend === 'android';
}

export type SnapshotState = {
  nodes: SnapshotNode[];
  createdAt: number;
  truncated?: boolean;
  backend?: SnapshotBackend;
  snapshotQuality?: SnapshotQualityVerdict;
  comparisonSafe?: boolean;
  presentationKey?: string;
};

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
  };
}

export function centerOfRect(rect: Rect): Point {
  return {
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
  };
}
