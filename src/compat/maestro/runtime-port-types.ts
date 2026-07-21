import type { Point, Rect } from '../../kernel/snapshot.ts';
import type {
  MaestroDirection,
  MaestroGestureTarget,
  MaestroLaunchArguments,
  MaestroPlatform,
  MaestroSelector,
  MaestroSourceLocation,
  MaestroSwipeGesture,
} from './program-ir.ts';
import type {
  MaestroObservation,
  MaestroObservationCondition,
  MaestroObservationEvidence,
} from './engine-types.ts';

export type MaestroRuntimeReadContext = {
  readonly appId?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly generation: number;
  readonly source?: MaestroSourceLocation;
  readonly cachedObservation?: MaestroObservation;
  readonly signal?: AbortSignal;
  readonly gestureViewport?: Rect;
};

export type MaestroRuntimeOperationContext = MaestroRuntimeReadContext & {
  readonly invalidateObservation: () => void;
};

/** Evidence returned by the shared selector runtime for one observation generation. */
export type MaestroTargetMatch = {
  readonly generation: number;
  readonly matched: boolean;
  readonly visible: boolean;
  readonly visiblePercentage?: number;
  readonly candidateCount: number;
  readonly rect?: Rect;
  readonly viewport?: Rect;
  readonly ref?: string;
  readonly dispatchSelector?: MaestroDispatchSelector;
  readonly surfaceSignature?: string;
};

export type MaestroDispatchSelector = {
  readonly key: 'id' | 'label' | 'text';
  readonly value: string;
};

export type MaestroSelectorEvidence = MaestroObservationEvidence;

export type MaestroTargetResolution = MaestroTargetMatch & {
  readonly kind: 'selector';
  readonly selector: MaestroSelector;
  readonly query: MaestroTargetQuery;
  readonly rect: Rect;
};

export type MaestroTargetQuery = {
  readonly selector: MaestroSelector;
  readonly purpose: 'tap' | 'doubleTap' | 'longPress' | 'swipe';
  readonly timeoutMs: number;
  readonly index?: number;
  readonly childOf?: MaestroSelector;
  readonly allowAtomicSelectorDispatch?: boolean;
  readonly includeSurfaceSignature?: boolean;
};

export type MaestroInputTarget = {
  readonly authored: MaestroGestureTarget;
  readonly point?: Point;
  readonly resolution?: MaestroTargetResolution;
};

export type MaestroSwipeOperation = {
  /** The authored Maestro coordinate space and target mode, preserved for policy and diagnostics. */
  readonly authored: MaestroSwipeGesture;
  /** The normalized contract consumed by the shared input runtime. */
  readonly gesture: MaestroSinglePointerGestureInput;
  readonly target?: MaestroTargetResolution;
  readonly viewport?: Rect;
};

export type MaestroSinglePointerGestureInput = {
  readonly from: Point;
  readonly to: Point;
  readonly durationMs: number;
};

export type MaestroRuntimeOperationResult = {
  readonly observation?: MaestroObservation;
  readonly outputEnv?: Record<string, string>;
  readonly artifactPaths?: readonly string[];
  /** Daemon response data surfaced for replay-trace evidence. */
  readonly data?: Record<string, unknown>;
  /** Internal completion evidence consumed by the daemon Maestro port. */
  readonly visualStabilityReached?: boolean;
};

export type MaestroRuntimeOperation<TInput> = (
  input: TInput,
  context: MaestroRuntimeOperationContext,
) => Promise<MaestroRuntimeOperationResult | void>;

export type MaestroRuntimeOperations = {
  readonly platform: Extract<MaestroPlatform, 'ios' | 'android'>;
  readonly resolveTarget: (
    input: MaestroTargetQuery,
    context: MaestroRuntimeReadContext,
  ) => Promise<MaestroTargetMatch>;
  readonly observe: (
    input: {
      readonly condition: MaestroObservationCondition;
      readonly timeoutMs: number;
    },
    context: MaestroRuntimeReadContext,
  ) => Promise<MaestroTargetMatch>;
  readonly resolveGestureViewport: (context: MaestroRuntimeReadContext) => Promise<Rect>;

  readonly launchApp: MaestroRuntimeOperation<{
    readonly appId?: string;
    readonly stopApp?: boolean;
    readonly clearState?: boolean;
    readonly arguments?: MaestroLaunchArguments;
    readonly launchArguments?: MaestroLaunchArguments;
  }>;
  readonly stopApp: MaestroRuntimeOperation<{ readonly appId?: string }>;
  readonly openLink: MaestroRuntimeOperation<{ readonly link: string }>;

  readonly tapOn: MaestroRuntimeOperation<{
    readonly target: MaestroInputTarget;
    readonly retryTapIfNoChange?: boolean;
    readonly repeat?: number;
    readonly delay?: number;
  }>;
  readonly doubleTapOn: MaestroRuntimeOperation<{
    readonly target: MaestroInputTarget;
    readonly delay?: number;
  }>;
  readonly longPressOn: MaestroRuntimeOperation<{ readonly target: MaestroInputTarget }>;
  readonly gesture: MaestroRuntimeOperation<MaestroSinglePointerGestureInput>;
  readonly inputText: MaestroRuntimeOperation<{ readonly text: string; readonly label?: string }>;
  readonly eraseText: MaestroRuntimeOperation<{ readonly charactersToErase?: number }>;
  readonly scroll: MaestroRuntimeOperation<{ readonly direction: MaestroDirection }>;
  readonly scrollUntilVisible: MaestroRuntimeOperation<{
    readonly selector: MaestroSelector;
    readonly direction: MaestroDirection;
    readonly timeoutMs: number;
    readonly durationMs: number;
  }>;
  readonly pressKey: MaestroRuntimeOperation<{
    readonly key: 'back' | 'enter' | 'return' | 'home';
  }>;
  readonly back: MaestroRuntimeOperation<Record<string, never>>;
  readonly hideKeyboard: MaestroRuntimeOperation<Record<string, never>>;
  readonly waitForAnimationToEnd: MaestroRuntimeOperation<{ readonly timeoutMs?: number }>;

  readonly takeScreenshot: MaestroRuntimeOperation<{ readonly path: string }>;
  readonly runScript: MaestroRuntimeOperation<{
    readonly file: string;
    readonly env?: Record<string, string | number | boolean>;
  }>;
};
