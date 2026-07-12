import type { NormalizedGestureInput } from '../../contracts/gesture-normalization.ts';
import type { Point, Rect } from '../../kernel/snapshot.ts';
import type {
  MaestroDirection,
  MaestroGestureTarget,
  MaestroLaunchArguments,
  MaestroSelector,
  MaestroSourceLocation,
  MaestroSwipeGesture,
} from './program-ir.ts';
import type {
  MaestroObservation,
  MaestroObservationCondition,
  MaestroObservationEvidence,
} from './engine-types.ts';

export type MaestroRuntimeOperationContext = {
  readonly appId?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly generation: number;
  readonly source?: MaestroSourceLocation;
  readonly cachedObservation?: MaestroObservation;
  readonly signal?: AbortSignal;
  readonly authoredSwipe?: MaestroSwipeGesture;
  readonly swipeTarget?: MaestroTargetResolution;
  readonly gestureViewport?: Rect;
};

/** Evidence returned by the shared selector runtime for one observation generation. */
export type MaestroTargetMatch = {
  readonly generation: number;
  readonly matched: boolean;
  readonly visible: boolean;
  readonly candidateCount: number;
  readonly rect?: Rect;
  readonly viewport?: Rect;
  readonly ref?: string;
};

export type MaestroSelectorEvidence = MaestroObservationEvidence;

export type MaestroTargetResolution = MaestroTargetMatch & {
  readonly kind: 'selector';
  readonly selector: MaestroSelector;
  readonly rect: Rect;
};

export type MaestroTargetQuery = {
  readonly selector: MaestroSelector;
  readonly purpose: 'tap' | 'doubleTap' | 'longPress' | 'swipe';
  readonly index?: number;
  readonly childOf?: MaestroSelector;
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
  readonly gesture: NormalizedGestureInput;
  readonly target?: MaestroTargetResolution;
  readonly viewport?: Rect;
};

export type MaestroRuntimeOperationResult = {
  readonly observation?: MaestroObservation;
  readonly outputEnv?: Record<string, string>;
  readonly artifactPaths?: readonly string[];
};

export type MaestroRuntimeOperation<TInput> = (
  input: TInput,
  context: MaestroRuntimeOperationContext,
) => Promise<MaestroRuntimeOperationResult | void>;

export type MaestroRuntimeOperations = {
  readonly resolveTarget: (
    input: MaestroTargetQuery,
    context: MaestroRuntimeOperationContext,
  ) => Promise<MaestroTargetMatch>;
  readonly observe: (
    input: {
      readonly condition: MaestroObservationCondition;
      readonly timeoutMs: number;
    },
    context: MaestroRuntimeOperationContext,
  ) => Promise<MaestroTargetMatch>;
  readonly resolveGestureViewport: (context: MaestroRuntimeOperationContext) => Promise<Rect>;

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
    readonly repeat?: number;
    readonly delay?: number;
    readonly optional?: boolean;
    readonly label?: string;
    readonly index?: number;
    readonly childOf?: MaestroSelector;
  }>;
  readonly doubleTapOn: MaestroRuntimeOperation<{
    readonly target: MaestroInputTarget;
    readonly delay?: number;
  }>;
  readonly longPressOn: MaestroRuntimeOperation<{ readonly target: MaestroInputTarget }>;
  readonly gesture: MaestroRuntimeOperation<NormalizedGestureInput>;
  readonly inputText: MaestroRuntimeOperation<{ readonly text: string; readonly label?: string }>;
  readonly eraseText: MaestroRuntimeOperation<{ readonly charactersToErase?: number }>;
  readonly pasteText: MaestroRuntimeOperation<{ readonly text: string }>;
  readonly scroll: MaestroRuntimeOperation<{ readonly direction: MaestroDirection }>;
  readonly scrollUntilVisible: MaestroRuntimeOperation<{
    readonly selector: MaestroSelector;
    readonly direction: MaestroDirection;
    readonly timeoutMs: number;
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
