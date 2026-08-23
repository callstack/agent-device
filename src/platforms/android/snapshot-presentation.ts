import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';
import { isPositiveFiniteRect } from '@agent-device/kernel/rect';

const ANDROID_SNAPSHOT_PRESENTATION_FAILED = 'ANDROID_SNAPSHOT_PRESENTATION_FAILED';
export const ANDROID_SNAPSHOT_PRESENTATION_DEFAULT_DEADLINE_MS = 250;

export type AndroidSnapshotPresentationOptions = {
  /** Absolute wall-clock deadline. This is internal and never CLI-exposed. */
  deadlineAtMs?: number;
  /** Injectable clock for deterministic deadline tests. */
  now?: () => number;
  /** Optional linear work cap; production builds derive one from the raw node count. */
  maxWorkUnits?: number;
};

export type AndroidSnapshotPresentationFailurePhase =
  | 'deadline'
  | 'complexity'
  | 'regular-invariant';

export type AndroidSnapshotPresentationFailureDetails = {
  phase: AndroidSnapshotPresentationFailurePhase;
  workUnits: number;
  deadlineAtMs?: number;
  maxWorkUnits?: number;
  nodeIndex?: number;
  frame?: Rect;
  clip?: Rect;
};

export type AndroidSnapshotPresentationAnalysis = {
  rawNodeCount: number;
  maxDepth: number;
};

export class AndroidSnapshotPresentationFailure extends Error {
  readonly code = ANDROID_SNAPSHOT_PRESENTATION_FAILED;
  readonly qualityReasonCode = 'presentation-failed' as const;
  readonly details: AndroidSnapshotPresentationFailureDetails;
  analysis?: AndroidSnapshotPresentationAnalysis;

  constructor(
    message: string,
    details: AndroidSnapshotPresentationFailureDetails,
    analysis?: AndroidSnapshotPresentationAnalysis,
  ) {
    super(message);
    this.name = 'AndroidSnapshotPresentationFailure';
    this.details = details;
    this.analysis = analysis;
  }
}

export function isAndroidSnapshotPresentationFailure(
  error: unknown,
): error is AndroidSnapshotPresentationFailure {
  if (error instanceof AndroidSnapshotPresentationFailure) {
    return error.code === ANDROID_SNAPSHOT_PRESENTATION_FAILED;
  }
  return Boolean(
    error &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === ANDROID_SNAPSHOT_PRESENTATION_FAILED,
  );
}

export class AndroidSnapshotPresentationBudget {
  private workUnits = 0;
  private readonly options: AndroidSnapshotPresentationOptions;
  private readonly defaultMaxWorkUnits: number;
  private readonly deadlineAtMs: number;

  constructor(options: AndroidSnapshotPresentationOptions, defaultMaxWorkUnits: number) {
    this.options = options;
    this.defaultMaxWorkUnits = defaultMaxWorkUnits;
    const now = options.now ?? Date.now;
    this.deadlineAtMs = options.deadlineAtMs ?? now() + defaultDeadlineMs();
  }

  get workUnitCount(): number {
    return this.workUnits;
  }

  check(phase: 'deadline' | 'complexity' | 'regular-invariant' | 'work'): void {
    void phase;
    this.consume(1);
  }

  consume(units: number): void {
    this.workUnits += units;
    const maxWorkUnits = this.options.maxWorkUnits ?? this.defaultMaxWorkUnits;
    if (this.workUnits > maxWorkUnits) {
      throw new AndroidSnapshotPresentationFailure(
        'Android snapshot presentation exceeded its linear work budget',
        {
          phase: 'complexity',
          workUnits: this.workUnits,
          maxWorkUnits,
        },
      );
    }
    const now = this.options.now ?? Date.now;
    if (now() >= this.deadlineAtMs) {
      throw new AndroidSnapshotPresentationFailure(
        'Android snapshot presentation exceeded its cooperative deadline',
        {
          phase: 'deadline',
          workUnits: this.workUnits,
          deadlineAtMs: this.deadlineAtMs,
          maxWorkUnits,
        },
      );
    }
  }
}

export function createAndroidSnapshotPresentationBudget(
  options: AndroidSnapshotPresentationOptions | undefined,
  defaultMaxWorkUnits: number,
): AndroidSnapshotPresentationBudget {
  return new AndroidSnapshotPresentationBudget(options ?? {}, defaultMaxWorkUnits);
}

/**
 * The typed carrier between Android acquisition facts and regular snapshot wire projection.
 *
 * `raw.rect` remains the helper-reported frame for raw output and traversal. `effectiveRect` is
 * the frame after the Android presentation clip fold. Keeping both values in one object prevents
 * a downstream consumer from accidentally publishing acquisition geometry for a regular node.
 */
export type AndroidSnapshotPresentationNode = {
  raw: RawSnapshotNode;
  effectiveRect?: Rect;
  clipsDescendants?: boolean;
  windowRect?: Rect;
};

export function createAndroidSnapshotPresentationNode(
  raw: RawSnapshotNode,
  effectiveRect?: Rect,
  clipsDescendants?: boolean,
  windowRect?: Rect,
): AndroidSnapshotPresentationNode {
  return {
    raw,
    ...(effectiveRect ? { effectiveRect } : {}),
    ...(clipsDescendants ? { clipsDescendants: true } : {}),
    ...(windowRect ? { windowRect } : {}),
  };
}

/**
 * Serializes the regular projection. The reported rectangle never crosses this boundary, and an
 * actionability claim is retained only when the effective geometry has positive area.
 */
export function serializeAndroidRegularPresentationNode(
  node: AndroidSnapshotPresentationNode,
): RawSnapshotNode {
  return {
    ...node.raw,
    ...(node.effectiveRect ? { rect: node.effectiveRect } : { rect: undefined }),
    hittable:
      node.raw.hittable === true && isPositiveFiniteRect(node.effectiveRect) ? true : undefined,
  };
}

/**
 * Folds the Android viewport and the nearest effective scroll clip into one cumulative clip.
 * Empty intersections keep the reported origin and become zero-area frames, matching the Swift
 * presentation geometry contract and keeping diagnostic coordinates useful.
 */
export function effectiveAndroidRect(
  reportedRect: Rect | undefined,
  viewport: Rect | undefined,
  ancestorClip: Rect | undefined,
): Rect | undefined {
  if (!reportedRect) return undefined;
  let effective = normalizeRect(reportedRect);
  if (viewport) effective = intersectRect(effective, viewport);
  if (ancestorClip) effective = intersectRect(effective, ancestorClip);
  return effective;
}

function intersectRect(left: Rect, right: Rect): Rect {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const maxX = Math.min(left.x + left.width, right.x + right.width);
  const maxY = Math.min(left.y + left.height, right.y + right.height);
  const hasIntersection = maxX > x && maxY > y;
  return {
    x: hasIntersection ? x : left.x,
    y: hasIntersection ? y : left.y,
    width: hasIntersection ? maxX - x : 0,
    height: hasIntersection ? maxY - y : 0,
  };
}

function normalizeRect(rect: Rect): Rect {
  return {
    x: rect.x,
    y: rect.y,
    width: Math.max(0, rect.width),
    height: Math.max(0, rect.height),
  };
}

export function validateAndroidRegularPresentation(
  nodes: AndroidSnapshotPresentationNode[],
  viewport: Rect | undefined,
  budget: AndroidSnapshotPresentationBudget,
): void {
  const clipIncludingNodeByIndex = new Map<number, Rect | undefined>();

  for (const node of nodes) {
    budget.check('regular-invariant');
    const ancestorClip = resolvePresentationAncestorClip(node, clipIncludingNodeByIndex, viewport);
    const frame = node.effectiveRect;

    if (!frame || !isPositiveFiniteRect(frame)) {
      // A helper may report a clickable node outside a scroll clip. The regular serializer clears
      // that actionability claim when its effective geometry is empty, so validate the wire-facing
      // projection rather than treating the raw acquisition fact as a presentation violation.
      if (serializeAndroidRegularPresentationNode(node).hittable === true) {
        throw new AndroidSnapshotPresentationFailure(
          `Android regular snapshot node ${node.raw.index} with degenerate effective geometry was marked hittable`,
          {
            phase: 'regular-invariant',
            workUnits: budget.workUnitCount,
            nodeIndex: node.raw.index,
            frame,
          },
        );
      }
      clipIncludingNodeByIndex.set(node.raw.index, ancestorClip);
      continue;
    }

    if (ancestorClip && !containsRect(frame, ancestorClip)) {
      throw new AndroidSnapshotPresentationFailure(
        `Android regular snapshot node ${node.raw.index} escaped its cumulative clip`,
        {
          phase: 'regular-invariant',
          workUnits: budget.workUnitCount,
          nodeIndex: node.raw.index,
          frame,
          clip: ancestorClip,
        },
      );
    }

    clipIncludingNodeByIndex.set(node.raw.index, node.clipsDescendants ? frame : ancestorClip);
  }
}

function resolvePresentationAncestorClip(
  node: AndroidSnapshotPresentationNode,
  clipIncludingNodeByIndex: ReadonlyMap<number, Rect | undefined>,
  viewport: Rect | undefined,
): Rect | undefined {
  const parentIndex = node.raw.parentIndex;
  if (parentIndex === undefined) return node.windowRect ?? viewport;
  return clipIncludingNodeByIndex.get(parentIndex) ?? node.windowRect ?? viewport;
}

function containsRect(frame: Rect, clip: Rect): boolean {
  const tolerance = 0.0001;
  return (
    frame.x >= clip.x - tolerance &&
    frame.y >= clip.y - tolerance &&
    frame.x + frame.width <= clip.x + clip.width + tolerance &&
    frame.y + frame.height <= clip.y + clip.height + tolerance
  );
}

function defaultDeadlineMs(): number {
  return ANDROID_SNAPSHOT_PRESENTATION_DEFAULT_DEADLINE_MS;
}
