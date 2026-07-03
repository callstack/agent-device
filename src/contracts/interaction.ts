import type { Point, SnapshotNode } from '../kernel/snapshot.ts';

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

export type PressCommandResult = ResolvedInteractionTarget & {
  backendResult?: Record<string, unknown>;
  message?: string;
  evidence?: InteractionEvidence;
};

export type FillCommandResult = ResolvedInteractionTarget & {
  text: string;
  warning?: string;
  backendResult?: Record<string, unknown>;
  message?: string;
  evidence?: InteractionEvidence;
};

export type LongPressCommandResult = ResolvedInteractionTarget & {
  durationMs?: number;
  backendResult?: Record<string, unknown>;
  message?: string;
};
