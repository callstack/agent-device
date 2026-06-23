import type { Point, SnapshotNode } from '../utils/snapshot.ts';

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
    }
  | {
      kind: 'ref';
      point?: Point;
      target: Extract<ResolvedTarget, { kind: 'ref' }>;
      node?: SnapshotNode;
      selectorChain?: string[];
      refLabel?: string;
    }
  | {
      kind: 'selector';
      point: Point;
      target: Extract<ResolvedTarget, { kind: 'selector' }>;
      node: SnapshotNode;
      selectorChain: string[];
      refLabel?: string;
    };

export type PressCommandResult = ResolvedInteractionTarget & {
  backendResult?: Record<string, unknown>;
  message?: string;
};

export type FillCommandResult = ResolvedInteractionTarget & {
  text: string;
  warning?: string;
  backendResult?: Record<string, unknown>;
  message?: string;
};

export type LongPressCommandResult = ResolvedInteractionTarget & {
  durationMs?: number;
  backendResult?: Record<string, unknown>;
  message?: string;
};
