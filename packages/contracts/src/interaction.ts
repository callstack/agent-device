import type { Point, SnapshotNode } from '@agent-device/kernel/snapshot';
import type { ResponseCost } from '@agent-device/kernel/contracts';
import type { ClickButton } from './click-button.ts';

export type SelectorTarget = {
  kind: 'selector';
  selector: string;
};

export type RefTarget = {
  kind: 'ref';
  ref: string;
  fallbackLabel?: string;
};

export type ElementTarget = SelectorTarget | RefTarget;

export type PointTarget = {
  kind: 'point';
  x: number;
  y: number;
};

export type InteractionTarget = ElementTarget | PointTarget;

export type ResolvedTarget =
  | {
      kind: 'selector';
      selector: string;
    }
  | {
      kind: 'ref';
      ref: string;
    };

/** The decisive criterion separating a resolveSelectorChain winner from its strongest runner-up (ADR 0012). */
export type DisambiguationTiebreak = 'visible' | 'deepest' | 'smallest-area';

/**
 * A disambiguation winner or losing alternative. `diagnosticRef` is an opaque,
 * non-`@` token — never a snapshot ref, never issued via `refsGeneration`,
 * never pinnable or usable as an `@ref` target. Strings are UTF-8 truncated
 * to 256 bytes.
 */
export type ResolutionDiagnosticEntry = {
  diagnosticRef: string;
  role?: string;
  label?: string;
};

/**
 * ADR 0012 decision 2: pre-action disclosure of how the acting path resolved
 * its target, including each endpoint of a target-authored drag. Never ref-issuing.
 * `direct-ios`/`not-observed` = the XCTest fast path has no daemon tree to
 * report from; `ref`/`label-fallback` = a stale `@ref` recovered via
 * first-match label lookup, never exact ref provenance; `alternatives` holds
 * at most 5 losing candidates, winner excluded.
 */
export type ResolutionDisclosure =
  | { source: 'runtime'; phase: 'pre-action'; kind: 'unique' }
  | {
      source: 'runtime';
      phase: 'pre-action';
      kind: 'disambiguated';
      matchCount: number;
      winnerDiagnostic: ResolutionDiagnosticEntry;
      tiebreak: DisambiguationTiebreak;
      alternatives: ResolutionDiagnosticEntry[];
    }
  | { source: 'ref'; phase: 'pre-action'; kind: 'exact' }
  | { source: 'ref'; phase: 'pre-action'; kind: 'label-fallback' }
  | { source: 'direct-ios'; kind: 'not-observed' };

/**
 * #1280 (ADR 0012 decision 3 amendment): recording-only side channel — the
 * labeled descendant an identity-empty press container was retargeted to.
 * Consumed exclusively at the recording boundary
 * (`interaction-touch-response.ts`): the recorded action entry and its
 * `target-v1` evidence key off this node/chain/ref-label, while every
 * response payload keeps describing the dispatched container. Never
 * serialized into a response.
 */
export type RecordingTargetOverride = {
  node: SnapshotNode;
  selectorChain: string[];
  refLabel?: string;
};

/**
 * #1654: a target its CALLER already resolved, against a tree the caller
 * captured itself, handed to the interaction leaf so the leaf does not resolve
 * the same `@ref` a second time.
 *
 * The sole producer is a mutating `find` (`src/daemon/handlers/find.ts`): it
 * captures, matches by locator, promotes to a hittable ancestor, and mints
 * `@eN` off the node it chose — then re-enters the interaction leaf. Without
 * this channel the leaf repeated an in-memory `@eN` lookup after find had
 * already selected the node. No reachable production path is currently known
 * to advance the tree in that interval; this type removes the duplicate lookup
 * structurally and keeps the selected ref/node/tree provenance together.
 *
 * What this does NOT skip: the shared guards. Occlusion, hittable-ancestor
 * promotion, and the off-screen check still run, on this node, at the same
 * symbols the ADR 0011 `runtime-ref` cells name — the pre-resolution replaces
 * the LOOKUP, not the guarantees.
 *
 * In-process only, like `RecordingTargetOverride` above: it travels on the
 * daemon-only `internal` request channel (`toDaemonRequest` never copies that
 * off the wire), carries live node references, and is never serialized into a
 * response.
 */
export type PreresolvedInteractionTarget = {
  /** The ref minted for `node`; the consumer validates it against the positional target. */
  ref: string;
  /** The node the caller resolved, after the caller's own promotion. */
  node: SnapshotNode;
  /** The tree `node` came from — the guards read its siblings for occlusion/viewport. */
  nodes: SnapshotNode[];
};

export type ResolvedInteractionTarget =
  | {
      kind: 'point';
      point: Point;
      preActionNodes?: SnapshotNode[];
    }
  | {
      kind: 'ref';
      point?: Point;
      target: Extract<ResolvedTarget, { kind: 'ref' }>;
      node?: SnapshotNode;
      selectorChain?: string[];
      refLabel?: string;
      targetHittable?: boolean;
      hint?: string;
      preActionNodes?: SnapshotNode[];
      resolution?: ResolutionDisclosure;
      recordingTarget?: RecordingTargetOverride;
    }
  | {
      kind: 'selector';
      point: Point;
      target: Extract<ResolvedTarget, { kind: 'selector' }>;
      node: SnapshotNode;
      selectorChain: string[];
      refLabel?: string;
      targetHittable?: boolean;
      hint?: string;
      preActionNodes?: SnapshotNode[];
      resolution?: ResolutionDisclosure;
      recordingTarget?: RecordingTargetOverride;
    };

/**
 * Opt-in (`--verify`) cheap post-condition evidence for mutating interaction
 * commands (#1047). `digest`/`nodeCount`/`interactiveNodeCount` describe a single
 * interactive-only capture taken right after the action; `changedFromBefore`
 * compares that digest against the pre-action capture the resolution path already
 * held, so no extra device round trip is spent beyond the one verify capture.
 * `changedFromBefore: false` is evidence, not failure — the command still
 * succeeded.
 */
export type InteractionEvidence = {
  foregroundApp?: string;
  nodeCount: number;
  interactiveNodeCount: number;
  digest: string;
  changedFromBefore: boolean;
};

export type SettleDiffLine = {
  kind: 'added' | 'removed';
  text: string;
  /**
   * Plain ref body (`e12`) for ADDED lines: minted from the settled tree that
   * became the stored session snapshot, so it is immediately actionable and
   * lets the MCP layer pin it at `refsGeneration`. Removed lines never carry
   * one — their refs name nodes of the replaced tree.
   */
  ref?: string;
};

/**
 * One still-present, actionable element on the settled tree, surfaced by the
 * unchanged-interactive tail (see `SettleObservation.tail`).
 */
export type SettleTailEntry = {
  ref: string;
  role: string;
  label?: string;
};

/**
 * Opt-in (`--settle`, #1101) post-action settled observation for mutating
 * interaction commands. After the action, the daemon re-captures the
 * interactive tree with `wait stable`'s quiet-window semantics and returns the
 * DIFF against the pre-action tree in the same response, collapsing the
 * dominant interact → observe round-trip pair into one.
 *
 * Best-effort by contract: settling never fails the action. `settled: false`
 * means the quiet window was never reached inside the budget (carousel/ticker/
 * animation) or a capture stalled; no diff/refs are issued because the
 * observation is advisory. `hint` tells callers how to observe explicitly.
 *
 * Token budget: `diff.lines` carries only added/removed display lines (the
 * unchanged bulk rides as `diff.summary.unchanged`), bounded by the daemon; a
 * full tree per interaction would invert the snapshot token-budget principle.
 */
/** Tuning for the settle wait; defaults live with the loop (stable-capture.ts). */
export type SettleParams = {
  quietMs?: number;
  timeoutMs?: number;
};

/**
 * The find read-action result, consumed verbatim on both sides of the
 * daemon/engine boundary (R2: the shape lives below both zones — a daemon-side
 * structural twin drifted into an identical clone before it moved here).
 */
export type FindReadResult =
  | { kind: 'found'; found: true; waitedMs?: number }
  | { kind: 'text'; ref: string; text: string; node: SnapshotNode }
  | { kind: 'attrs'; ref: string; node: SnapshotNode }
  /** #1625: the read-only inspection surface — every match, never a tap. */
  | { kind: 'list'; matches: Array<{ ref: string; node: SnapshotNode }> };

export type SettleObservation = {
  settled: boolean;
  waitedMs: number;
  captures: number;
  quietMs: number;
  timeoutMs: number;
  /**
   * The session's snapshot generation after the settled tree became the stored
   * snapshot (#1076 versioned refs). Attached by the daemon response layer
   * when `diff` is present: added lines carry refs minted from that tree, so
   * the response is ref-issuing — the MCP layer merges per-ref pins from it
   * exactly like snapshot/find responses.
   */
  refsGeneration?: number;
  /**
   * Digest response view only: capped added-line refs preserved without the
   * verbose diff line text, so MCP can still pin refs when `diff.lines` is
   * intentionally omitted.
   */
  refs?: Array<{ ref: string }>;
  /** Present only for `settled: true` observations that stored the settled tree. */
  diff?: {
    summary: { additions: number; removals: number; unchanged: number };
    lines: SettleDiffLine[];
    /** Present (true) when lines were capped to the response bound. */
    truncated?: boolean;
  };
  /**
   * Unchanged interactive refs tail: benchmarks (July 2026) showed 27% of
   * `--settle` actions were followed by a fallback `snapshot -i` because a
   * change-only diff omits refs for elements that did not change — after a
   * modal dismiss the diff shows only removals, and the next button to press
   * (already on screen, untouched) is absent from the response. `tail` lists
   * the settled tree's remaining uncovered interactive elements (excluding
   * structural application/window chrome and the keyboard window's chrome)
   * so the response stays actionable without that extra round trip. Attached
   * ONLY when `diff` carries zero added-line refs naming a NEW target (the
   * modal-dismiss/toast-only/fill signature) — a diff whose added refs hand
   * the next target already pays its way, so the tail would be pure byte
   * cost. Keyboard-chrome refs and self-echo refs (added lines whose node
   * contains the action point: the acted-on element re-describing itself,
   * e.g. a filled field re-labeled with its new value) do not count as new
   * targets. Refs already present on `diff`'s added lines are excluded.
   * Capped; `tailTruncated` marks when candidates exceeded the cap.
   */
  tail?: SettleTailEntry[];
  tailTruncated?: true;
  hint?: string;
};

/**
 * Public daemon response data shared by press/click/fill/longpress.
 * `buildInteractionResponseData` emits this shape (ADR 0011 Layer 2):
 * `targetKind` discriminates the resolved target, identity fields are FLAT
 * (`ref`, `selector`, `x`, `y`), and per-command extras ride alongside.
 */
type TouchResponseDataBase = {
  message?: string;
  warning?: string;
  x?: number;
  y?: number;
  referenceWidth?: number;
  referenceHeight?: number;
  evidence?: InteractionEvidence;
  settle?: SettleObservation;
  resolution?: ResolutionDisclosure;
  cost?: ResponseCost;
  /** Direct iOS Maestro coordinate-fallback signals. */
  maestroNonHittableCoordinateFallbackAllowed?: boolean;
  maestroNonHittableCoordinateFallbackUsed?: boolean;
  maestroFallbackReason?: 'non-hittable-coordinate';
};

type TouchResponsePoint = TouchResponseDataBase & {
  targetKind: 'point';
  x: number;
  y: number;
};

type TouchResponseRef = TouchResponseDataBase & {
  targetKind: 'ref';
  ref: string;
  refLabel?: string;
  selectorChain?: string[];
  targetHittable?: boolean;
  hint?: string;
};

type TouchResponseSelector = TouchResponseDataBase & {
  targetKind: 'selector';
  selector: string;
  selectorChain?: string[];
  refLabel?: string;
  targetHittable?: boolean;
  hint?: string;
};

type TouchPressExtras = {
  button?: ClickButton;
  count?: number;
  intervalMs?: number;
  holdMs?: number;
  jitterPx?: number;
  doubleTap?: boolean;
};

export type PressCommandResponseData =
  | (TouchResponsePoint & TouchPressExtras)
  | (TouchResponseRef & TouchPressExtras)
  | (TouchResponseSelector & TouchPressExtras);

export type ClickCommandResponseData = PressCommandResponseData;

type TouchFillExtras = {
  text: string;
  delayMs?: number;
};

export type FillCommandResponseData =
  | (TouchResponsePoint & TouchFillExtras)
  | (TouchResponseRef & TouchFillExtras)
  | (TouchResponseSelector & TouchFillExtras);

type TouchLongPressExtras = {
  durationMs?: number;
  gesture: 'longpress';
};

export type LongPressCommandResponseData =
  | (TouchResponsePoint & TouchLongPressExtras)
  | (TouchResponseRef & TouchLongPressExtras)
  | (TouchResponseSelector & TouchLongPressExtras);

/**
 * Internal runtime result for press/click. The daemon response layer turns
 * this into `PressCommandResponseData` via `buildInteractionResponseData`.
 */
export type PressCommandResult = ResolvedInteractionTarget & {
  backendResult?: Record<string, unknown>;
  message?: string;
  warning?: string;
  evidence?: InteractionEvidence;
  settle?: SettleObservation;
};

/**
 * Internal runtime result for fill. The daemon response layer turns this into
 * `FillCommandResponseData` via `buildInteractionResponseData`.
 */
export type FillCommandResult = ResolvedInteractionTarget & {
  text: string;
  warning?: string;
  backendResult?: Record<string, unknown>;
  message?: string;
  evidence?: InteractionEvidence;
  settle?: SettleObservation;
};

/**
 * Internal runtime result for longpress. The daemon response layer turns this
 * into `LongPressCommandResponseData` via `buildInteractionResponseData`.
 */
export type LongPressCommandResult = ResolvedInteractionTarget & {
  durationMs?: number;
  backendResult?: Record<string, unknown>;
  message?: string;
  warning?: string;
  settle?: SettleObservation;
};

/**
 * Daemon response data for the `find` command. Read-only actions (`exists`,
 * `wait`, `get_text`, `get_attrs`) may issue a pinnable ref with
 * `refsGeneration`; mutating actions (`click`, `fill`, `focus`, `type`) carry
 * `ref` as diagnostic pre-action identity and intentionally omit `refsGeneration`
 * (ADR 0014). The shape is intentionally a flat, optional-field record because
 * the action positional changes which fields are present.
 */
export type FindCommandResponseData = {
  ref?: string;
  refsGeneration?: number;
  found?: true;
  waitedMs?: number;
  text?: string;
  node?: SnapshotNode;
  /** Every match of the read-only `list` action (#1625), each ref pinnable at `refsGeneration`. */
  matches?: Array<{ ref: string; node: SnapshotNode }>;
  locator?: string;
  query?: string;
  x?: number;
  y?: number;
  message?: string;
  settle?: SettleObservation;
  cost?: ResponseCost;
};

/**
 * Repeated-activation options shared by tap-like interactions: how many
 * times, how fast, how long each contact holds, and whether the pair is a
 * double-tap. Declared here (below both its consumers) so the backend
 * surface and the command-input parsers agree on one shape without either
 * importing the other.
 */
export type RepeatedInput = {
  count?: number;
  intervalMs?: number;
  holdMs?: number;
  jitterPx?: number;
  doubleTap?: boolean;
};
