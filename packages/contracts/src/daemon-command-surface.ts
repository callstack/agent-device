// The command surface a host injects into the daemon, stated as the daemon needs it: the
// daemon's reach into the command surface without a type edge into `src/commands/`. The
// composition root assigns `createCommandSurfaceAgentDevice` to this type, so the compiler
// checks every signature against the implementation on each build.

import type { SessionSurface } from './session-surface.ts';
import type { ArtifactDescriptor, FileOutputRef } from './artifact-adapter.ts';
import type { DeviceRotation } from './device-rotation.ts';
import type { ClickButton } from './click-button.ts';
import type { DiffSnapshotCommandResult } from './diff.ts';
import type { SnapshotDiagnosticsSummary } from './snapshot-diagnostics.ts';
import type { PublicSnapshotCaptureAnnotations } from './snapshot-capture-annotations.ts';
import type { ReplayTargetGuardDenotation } from './replay.ts';
import type { TargetAnnotationV1 } from './target-annotation.ts';
import type {
  DragGestureInput,
  GestureIntent,
  GestureSemanticInput,
} from './gesture-plan-types.ts';
import type { FindLocator } from './snapshot-types.ts';
import type {
  FillCommandResult,
  FindReadResult,
  HoverCommandResult,
  InteractionTarget,
  LongPressCommandResult,
  PressCommandResult,
  PreresolvedInteractionTarget,
  RepeatedInput,
  ResolutionDisclosure,
  ResolvedTarget,
  SettleObservation,
  SettleParams,
  SurfaceScopedNodes,
} from './interaction.ts';
import type { IsPredicate } from './is-predicate.ts';
import type { AgentDeviceRuntimeConfig, CommandContext } from './runtime-contract.ts';
import type {
  Point,
  SnapshotCommandOptionFields,
  SnapshotKeyboardBandFact,
  SnapshotNode,
  SnapshotUnchanged,
  SnapshotViewportSize,
} from '@agent-device/kernel/snapshot';

/** The `--verify` / `--settle` post-action observation the touch routes forward. */
export type DaemonPostActionOptions = Readonly<{
  verify?: boolean;
  settle?: SettleParams;
}>;

/** The snapshot-scoping options a selector read carries alongside its target. */
export type DaemonSelectorSnapshotOptions = Readonly<{
  depth?: number;
  scope?: string;
  raw?: boolean;
}>;

/** The options of the daemon's `snapshot` / `diff snapshot` calls. */
export type DaemonSnapshotOptions = CommandContext & SnapshotCommandOptionFields;

/** What the daemon's `screenshot` route and its two observation paths receive. */
export type DaemonScreenshotResult = Readonly<{
  path: string;
  artifacts?: ArtifactDescriptor[];
  displayRotation?: DeviceRotation;
  message?: string;
  warnings?: string[];
}>;

/** What the daemon's `snapshot` route publishes and its sparse-quality guard reads. */
export type DaemonSnapshotResult = Readonly<
  {
    nodes: SnapshotNode[];
    truncated?: boolean;
    appName?: string;
    appBundleId?: string;
    unchanged?: SnapshotUnchanged;
    snapshotDiagnostics?: SnapshotDiagnosticsSummary;
    keyboard?: SnapshotKeyboardBandFact;
    viewport?: SnapshotViewportSize;
  } & PublicSnapshotCaptureAnnotations
>;

export type DaemonScreenshotCommandOptions = CommandContext &
  Readonly<{
    out?: FileOutputRef;
    fullscreen?: boolean;
    overlayRefs?: boolean;
    pixelDensity?: number;
    scale?: number;
    stabilize?: boolean;
    normalizeStatusBar?: boolean;
    appId?: string;
    appBundleId?: string;
    surface?: SessionSurface;
  }>;

export type DaemonFindOptions = CommandContext &
  DaemonSelectorSnapshotOptions &
  Readonly<{
    locator?: FindLocator;
    query: string;
    action: 'exists' | 'wait' | 'get_text' | 'get_attrs' | 'list';
    timeoutMs?: number;
  }>;

export type DaemonGetOptions = CommandContext &
  DaemonSelectorSnapshotOptions &
  Readonly<{
    property: 'text' | 'attrs';
    target: InteractionTarget;
    /** ADR 0012 step 4: replay-only post-resolution guard. */
    expectedResolvedTarget?: ReplayTargetGuardDenotation;
  }>;

/**
 * A resolved read reports the element, its value, and the tree it resolved against
 * (#1349 record-time evidence).
 */
export type DaemonGetResult =
  | Readonly<{
      kind: 'text';
      target: ResolvedTarget;
      text: string;
      node: SnapshotNode;
      selectorChain?: string[];
      preActionNodes: SnapshotNode[];
    }>
  | Readonly<{
      kind: 'attrs';
      target: ResolvedTarget;
      node: SnapshotNode;
      selectorChain?: string[];
      preActionNodes: SnapshotNode[];
    }>;

export type DaemonIsOptions = CommandContext &
  DaemonSelectorSnapshotOptions &
  Readonly<{
    predicate: IsPredicate;
    selector: string;
    expectedText?: string;
    expectedResolvedTarget?: ReplayTargetGuardDenotation;
  }>;

export type DaemonIsResult = Readonly<{
  predicate: IsPredicate;
  pass: true;
  selector: string;
  matches?: number;
  text?: string;
  selectorChain?: string[];
  node?: SnapshotNode;
  preActionNodes?: SnapshotNode[];
}>;

export type DaemonWaitTarget =
  | { kind: 'sleep'; durationMs: number }
  | { kind: 'text'; text: string; timeoutMs?: number | null }
  | { kind: 'ref'; ref: string; timeoutMs?: number | null }
  | {
      kind: 'selector';
      selector: string;
      timeoutMs?: number | null;
      /** ADR 0012 / #1349: the recorded landmark identity a replayed wait must observe. */
      recordedLandmark?: TargetAnnotationV1;
    }
  | { kind: 'absent'; selector: string; timeoutMs?: number | null }
  | { kind: 'stable'; quietMs?: number | null; timeoutMs?: number | null };

export type DaemonWaitOptions = CommandContext &
  DaemonSelectorSnapshotOptions &
  Readonly<{ target: DaemonWaitTarget }>;

export type DaemonWaitResult = Readonly<{
  kind: 'sleep' | 'text' | 'selector' | 'absent' | 'stable';
  waitedMs: number;
  text?: string;
  selector?: string;
  captures?: number;
  nodeCount?: number;
  hint?: string;
  node?: SnapshotNode;
  preActionNodes?: SnapshotNode[];
}>;

export type DaemonWaitForTextOptions = CommandContext &
  DaemonSelectorSnapshotOptions &
  Readonly<{ text: string; timeoutMs?: number | null }>;

export type DaemonPressOptions = CommandContext &
  RepeatedInput &
  DaemonPostActionOptions &
  Readonly<{
    target: InteractionTarget;
    button?: ClickButton;
    /** Polls for the target to become actionable; absent takes one attempt. */
    readinessTimeoutMs?: number;
    expectedResolvedTarget?: ReplayTargetGuardDenotation;
    /** #1654: a mutating `find`'s already-resolved node. */
    preresolvedTarget?: PreresolvedInteractionTarget;
  }>;

export type DaemonFillOptions = CommandContext &
  DaemonPostActionOptions &
  Readonly<{
    target: InteractionTarget;
    text: string;
    delayMs?: number;
    /** Internal Maestro replay policy, forwarded only to the platform action. */
    allowNonHittableCoordinateFallback?: boolean;
    expectedResolvedTarget?: ReplayTargetGuardDenotation;
    preresolvedTarget?: PreresolvedInteractionTarget;
  }>;

export type DaemonLongPressOptions = CommandContext &
  Readonly<{
    target: InteractionTarget;
    durationMs?: number;
    readinessTimeoutMs?: number;
    expectedResolvedTarget?: ReplayTargetGuardDenotation;
    settle?: SettleParams;
  }>;

export type DaemonHoverOptions = CommandContext &
  Readonly<{
    target: InteractionTarget;
    expectedResolvedTarget?: ReplayTargetGuardDenotation;
    settle?: SettleParams;
  }>;

export type DaemonGestureOptions = CommandContext &
  (
    | Readonly<{ gesture: GestureSemanticInput }>
    | Readonly<{
        gesture: DragGestureInput;
        expectedResolvedTargets?: {
          source?: ReplayTargetGuardDenotation;
          destination?: ReplayTargetGuardDenotation;
        };
      }>
  );

/** A coordinate gesture reports the frame it settled on. */
export type DaemonCoordinateGestureResult = Readonly<{
  kind: GestureIntent;
  durationMs: number;
  pointerCount: 1 | 2;
  from: Point;
  to: Point;
  backendResult?: Record<string, unknown>;
  message?: string;
}>;

/** A drag additionally reports its two endpoints and what a replay needs to re-issue them. */
export type DaemonDragGestureResult = Readonly<{
  kind: 'drag';
  durationMs: number;
  pointerCount: 1;
  from: Point;
  to: Point;
  backendResult?: Record<string, unknown>;
  message?: string;
  targets: Readonly<{
    source: DaemonDragEndpointDisclosure;
    destination: DaemonDragEndpointDisclosure;
  }>;
  recording?: Readonly<{
    sourceSelector?: string;
    destinationSelector?: string;
    sourceTarget?: DaemonDragRecordingTarget;
    destinationTarget?: DaemonDragRecordingTarget;
  }>;
}>;

export type DaemonGestureResult = DaemonCoordinateGestureResult | DaemonDragGestureResult;

type DaemonDragEndpointDisclosure = Readonly<{
  selectorChain?: string[];
  resolution: ResolutionDisclosure;
}>;

type DaemonDragRecordingTarget = Readonly<{
  selectorChain: string[];
  node: SnapshotNode;
  preActionNodes: SnapshotNode[];
}>;

export type DaemonSettleObservationOptions = CommandContext &
  SettleParams &
  Readonly<{
    /** The pre-action tree the settled diff is taken against, and the surface it describes. */
    baseline: SurfaceScopedNodes;
  }>;

/** The three captures the daemon runs. */
export type DaemonCommandSurfaceCapture = Readonly<{
  screenshot(options: DaemonScreenshotCommandOptions): Promise<DaemonScreenshotResult>;
  snapshot(options: DaemonSnapshotOptions): Promise<DaemonSnapshotResult>;
  diffSnapshot(options: DaemonSnapshotOptions): Promise<DiffSnapshotCommandResult>;
}>;

/** The five selector reads the daemon's selector and wait routes serve. */
export type DaemonCommandSurfaceSelectors = Readonly<{
  find(options: DaemonFindOptions): Promise<FindReadResult>;
  get(options: DaemonGetOptions): Promise<DaemonGetResult>;
  is(options: DaemonIsOptions): Promise<DaemonIsResult>;
  wait(options: DaemonWaitOptions): Promise<DaemonWaitResult>;
  waitForText(
    text: string,
    options?: Omit<DaemonWaitForTextOptions, 'text'>,
  ): Promise<DaemonWaitResult>;
}>;

/** The seven actions the daemon's touch, gesture and settle routes serve. */
export type DaemonCommandSurfaceInteractions = Readonly<{
  click(
    target: InteractionTarget,
    options?: Omit<DaemonPressOptions, 'target'>,
  ): Promise<PressCommandResult>;
  press(
    target: InteractionTarget,
    options?: Omit<DaemonPressOptions, 'target'>,
  ): Promise<PressCommandResult>;
  fill(
    target: InteractionTarget,
    text: string,
    options?: Omit<DaemonFillOptions, 'target' | 'text'>,
  ): Promise<FillCommandResult>;
  longPress(
    target: InteractionTarget,
    options?: Omit<DaemonLongPressOptions, 'target'>,
  ): Promise<LongPressCommandResult>;
  hover(
    target: InteractionTarget,
    options?: Omit<DaemonHoverOptions, 'target'>,
  ): Promise<HoverCommandResult>;
  gesture(options: DaemonGestureOptions): Promise<DaemonGestureResult>;
  settleObservation(options: DaemonSettleObservationOptions): Promise<SettleObservation>;
}>;

/** What a daemon route may call, and nothing else. */
export type DaemonCommandSurface = Readonly<{
  /** The cancellation signal this surface's runtime was assembled with. */
  signal?: AbortSignal;
  capture: DaemonCommandSurfaceCapture;
  selectors: DaemonCommandSurfaceSelectors;
  interactions: DaemonCommandSurfaceInteractions;
}>;

/**
 * The injection seam: one command surface per request-bound runtime config. The composition root
 * supplies `createCommandSurfaceAgentDevice`; a test supplies a fake through the same seam.
 */
export type CreateDaemonCommandSurface = (config: AgentDeviceRuntimeConfig) => DaemonCommandSurface;
