import type { AppLogRuntimeHost, AppLogRuntimeOperations } from './app-log-runtime.ts';
import type {
  AppInventoryRuntimeHost,
  AppInventoryRuntimeOperations,
} from './app-inventory-runtime.ts';
import type {
  AndroidAppDeploymentExecutor,
  AppDeploymentRuntimeOperations,
  AppleAppDeploymentExecutor,
} from './app-deployment-runtime.ts';
import type { AppStateRuntimeHost, AppStateRuntimeOperations } from './app-state-runtime.ts';
import type { NetworkRuntimeHost, NetworkRuntimeOperations } from './network-runtime.ts';
import type { ScreenRecordingRuntimeHost } from './screen-recording-runtime-host.ts';
import type { ScreenRecordingRuntimeOperations } from './screen-recording-runtime.ts';
import type { ScreenshotRuntimeOperations } from './screenshot-runtime.ts';
import type { SnapshotRuntimeHost, SnapshotRuntimeOperations } from './snapshot-runtime.ts';
import type { SelectorObservationRuntimeOperations } from './selector-observation-runtime.ts';
import type { ViewportRuntimeOperations } from './viewport-runtime.ts';
import type { FocusRuntimeOperations } from './focus-runtime.ts';
import type { GestureCommandInput, GestureSemanticInput } from './gesture-plan-types.ts';
import type { GestureRuntimeTier } from './gesture-tier.ts';
import type { GestureRuntimeOperations } from './gesture-runtime.ts';
import type { ScrollRuntimeOperations } from './scroll-runtime.ts';
import type { TypeTextRuntimeOperations } from './type-text-runtime.ts';
import type { ElementTextRuntimeOperations } from './element-text-runtime.ts';
import type { BackRuntimeOperations } from './back-runtime.ts';
import type { HomeRuntimeOperations } from './home-runtime.ts';
import type { OrientationRuntimeOperations } from './orientation-runtime.ts';
import type { TvRemoteRuntimeOperations } from './tv-remote-runtime.ts';
import type { KeyboardRuntimeOperations } from './keyboard-runtime.ts';
import type { ClipboardRuntimeOperations } from './clipboard-runtime.ts';
import type { AppSwitcherRuntimeOperations } from './app-switcher-runtime.ts';
import type { AppEventRuntimeOperations } from './app-event-runtime.ts';
import type { SettingsRuntimeOperations } from './settings-runtime.ts';
import type { AlertRuntimeOperations } from './alert-runtime.ts';
import type { AudioProbeRuntimeOperations } from './audio-probe-runtime.ts';
import type { AudioProbeRuntimeHost } from './audio-probe-runtime-host.ts';
import type { PerfRuntimeOperations } from './perf-runtime.ts';
import type { PerfRuntimeHost } from './perf-runtime-host.ts';
import type { TouchRuntimeOperations } from './touch-runtime.ts';
import type {
  DeviceReadinessRuntimeHost,
  DeviceReadinessRuntimeOperations,
} from './device-readiness-runtime.ts';
import type {
  DeviceShutdownRuntimeHost,
  DeviceShutdownRuntimeOperations,
} from './device-shutdown-runtime.ts';
import type {
  AndroidApplicationTools,
  AppleApplicationTools,
  ApplicationLifecycleResourceLifecycle,
  ApplicationLifecycleRuntimeOperations,
  LocalApplicationInteractorHost,
} from './application-lifecycle-runtime.ts';
import {
  type DeviceRuntimeOwner,
  type RuntimeOwnerRef,
  type RuntimePlatformModule,
} from './platform-runtime.ts';
import { runtimeUse } from './platform-runtime-use.ts';
import type { AndroidToolHost } from './platform-runtime-host.ts';

export type PlatformRuntimeOperations = AppLogRuntimeOperations &
  AppInventoryRuntimeOperations &
  AppDeploymentRuntimeOperations &
  AppStateRuntimeOperations &
  NetworkRuntimeOperations &
  ScreenRecordingRuntimeOperations &
  ScreenshotRuntimeOperations &
  SnapshotRuntimeOperations &
  SelectorObservationRuntimeOperations &
  ViewportRuntimeOperations &
  FocusRuntimeOperations &
  GestureRuntimeOperations &
  ScrollRuntimeOperations &
  TypeTextRuntimeOperations &
  ElementTextRuntimeOperations &
  BackRuntimeOperations &
  HomeRuntimeOperations &
  OrientationRuntimeOperations &
  TvRemoteRuntimeOperations &
  KeyboardRuntimeOperations &
  ClipboardRuntimeOperations &
  AppSwitcherRuntimeOperations &
  AppEventRuntimeOperations &
  SettingsRuntimeOperations &
  AlertRuntimeOperations &
  AudioProbeRuntimeOperations &
  PerfRuntimeOperations &
  TouchRuntimeOperations &
  DeviceReadinessRuntimeOperations &
  DeviceShutdownRuntimeOperations &
  ApplicationLifecycleRuntimeOperations;

/**
 * The one neutral runtime-use declaration every command domain shares (ADR 0019 §9): no
 * per-domain currying wrappers. Lives here, next to the concrete `PlatformRuntimeOperations`
 * catalog it closes over, so the generic `runtimeUse` primitive stays independent of this
 * command-domain catalog.
 */
export const defineUse = runtimeUse<PlatformRuntimeOperations>();

export const bootTargetUse = defineUse({ required: ['bootTarget'] });
export const bootTargetHeadlessUse = defineUse({
  required: ['bootTargetHeadless'],
});
export const appsRuntimeUse = defineUse({ required: ['ensureReady', 'listApps'] });
export const captureSnapshotUse = defineUse({ required: ['captureSnapshot'] });
export const viewportRuntimeUse = defineUse({ required: ['setViewport'] });
export const focusRuntimeUse = defineUse({ required: ['focusPoint'] });
export const typeTextRuntimeUse = defineUse({ required: ['typeText'] });
export const backRuntimeUse = defineUse({ required: ['back'] });
export const homeRuntimeUse = defineUse({ required: ['home'] });
export const orientationRuntimeUse = defineUse({ required: ['setOrientation'] });
export const tvRemoteRuntimeUse = defineUse({ required: ['tvRemote'] });
export const keyboardStatusUse = defineUse({ required: ['keyboardStatus'] });
export const keyboardDismissUse = defineUse({ required: ['keyboardDismiss'] });
export const keyboardEnterUse = defineUse({ required: ['keyboardEnter'] });
export const appSwitcherRuntimeUse = defineUse({ required: ['appSwitcher'] });
export const appEventRuntimeUse = defineUse({ required: ['triggerAppEvent'] });
export const settingsRuntimeUse = defineUse({ required: ['setSetting'] });
export const alertReadUse = defineUse({ required: ['readAlert'] });
export const alertWaitUse = defineUse({ required: ['awaitAlert'] });
export const alertAcceptUse = defineUse({ required: ['acceptAlert'] });
export const alertDismissUse = defineUse({ required: ['dismissAlert'] });
export const clipboardReadUse = defineUse({ required: ['readClipboard'] });
export const clipboardWriteUse = defineUse({ required: ['writeClipboard'] });
export const perfFramesUse = defineUse({ required: ['perfFrames'] });
export const perfMemorySampleUse = defineUse({ required: ['perfMemorySample'] });
export const perfMemorySnapshotUse = defineUse({ required: ['perfMemorySnapshot'] });
export const perfNativeCaptureStartUse = defineUse({ required: ['perfNativeCaptureStart'] });
export const perfNativeCaptureRecoveryUse = defineUse({
  required: ['perfNativeCaptureReattach', 'perfNativeCaptureCleanup'],
});
export const perfProfileReportUse = defineUse({ required: ['perfProfileReport'] });
export const perfRuntimePlanUses = Object.freeze([
  perfFramesUse,
  perfMemorySampleUse,
  perfMemorySnapshotUse,
  perfNativeCaptureStartUse,
  perfNativeCaptureRecoveryUse,
  perfProfileReportUse,
] as const);
export const tapPointUse = defineUse({ required: ['tapPoint'] });
export const capturedTapUse = defineUse({
  required: ['captureSnapshot', 'tapPoint'],
  preferred: ['tapRef'],
  conditional: ['tapElementSelector'],
});
export const longPressPointUse = defineUse({ required: ['longPressPoint'] });
export const capturedLongPressUse = defineUse({
  required: ['captureSnapshot', 'longPressPoint'],
});
export const hoverPointUse = defineUse({ required: ['hoverPoint'] });
export const capturedHoverUse = defineUse({
  required: ['captureSnapshot', 'hoverPoint'],
  preferred: ['hoverRef'],
});
export const fillPointUse = defineUse({ required: ['fillPoint'] });
export const capturedFillUse = defineUse({
  required: ['captureSnapshot', 'fillPoint'],
  preferred: ['fillRef'],
});

export const clickRuntimeUses = Object.freeze([tapPointUse, capturedTapUse] as const);
export const pressRuntimeUses = clickRuntimeUses;
export const longPressRuntimeUses = Object.freeze([
  longPressPointUse,
  capturedLongPressUse,
] as const);
export const hoverRuntimeUses = Object.freeze([hoverPointUse, capturedHoverUse] as const);
export const fillRuntimeUses = Object.freeze([fillPointUse, capturedFillUse] as const);

export type TouchRuntimePlan =
  | Readonly<{ kind: 'tap-point'; use: typeof tapPointUse }>
  | Readonly<{ kind: 'captured-tap'; use: typeof capturedTapUse }>
  | Readonly<{
      kind: 'long-press-point';
      use: typeof longPressPointUse;
    }>
  | Readonly<{
      kind: 'captured-long-press';
      use: typeof capturedLongPressUse;
    }>
  | Readonly<{ kind: 'hover-point'; use: typeof hoverPointUse }>
  | Readonly<{
      kind: 'captured-hover';
      use: typeof capturedHoverUse;
    }>
  | Readonly<{ kind: 'fill-point'; use: typeof fillPointUse }>
  | Readonly<{ kind: 'captured-fill'; use: typeof capturedFillUse }>;

export function resolveTouchRuntimePlan(
  command: 'click' | 'press' | 'fill' | 'longpress' | 'hover',
  requiresCapture: boolean,
): TouchRuntimePlan {
  switch (command) {
    case 'click':
    case 'press':
      return requiresCapture
        ? { kind: 'captured-tap', use: capturedTapUse }
        : { kind: 'tap-point', use: tapPointUse };
    case 'fill':
      return requiresCapture
        ? { kind: 'captured-fill', use: capturedFillUse }
        : { kind: 'fill-point', use: fillPointUse };
    case 'longpress':
      return requiresCapture
        ? { kind: 'captured-long-press', use: capturedLongPressUse }
        : { kind: 'long-press-point', use: longPressPointUse };
    case 'hover':
      return requiresCapture
        ? { kind: 'captured-hover', use: capturedHoverUse }
        : { kind: 'hover-point', use: hoverPointUse };
  }
}

/**
 * The gesture family's action-selected uses (ADR 0019 §9: one bind per handler). A gesture input
 * needs exactly one execution tier, so each tier carries the complete requirement set and the
 * handler binds once — for the whole `swipe --count N` series as much as for one `gesture pinch`.
 *
 * Every tier binds snapshot capture with its action because capture is the fallback when the owner
 * has no direct viewport read. `gestureViewport` remains preferred.
 */
const gesturePlanUse = defineUse({
  required: ['performGesturePlan', 'captureSnapshot'],
  preferred: ['gestureViewport'],
});
const gestureDirectionalFlingUse = defineUse({
  required: ['performDirectionalFlingPlan', 'captureSnapshot'],
  preferred: ['gestureViewport'],
});
const gestureMultiTouchUse = defineUse({
  required: ['performMultiTouchGesturePlan', 'captureSnapshot'],
  preferred: ['gestureViewport'],
});
const gestureTargetAuthoredDragUse = defineUse({
  required: ['performTargetAuthoredDrag', 'captureSnapshot'],
  preferred: ['gestureViewport'],
});

/** `scroll <direction>` executes one pass and needs nothing else. */
const scrollDirectionUse = defineUse({ required: ['scrollDirection'] });
/**
 * `scroll top` / `scroll bottom` verify hidden content between passes, so the capture is part of
 * the tier's requirement rather than something discovered mid-run — the retired leaf's
 * "requires snapshot support to verify hidden content before scrolling" refusal, moved to
 * admission.
 */
const scrollEdgeUse = defineUse({ required: ['scrollDirection', 'captureSnapshot'] });

const gestureUsesByTier = Object.freeze({
  plan: gesturePlanUse,
  'directional-fling': gestureDirectionalFlingUse,
  'multi-touch': gestureMultiTouchUse,
  'target-authored-drag': gestureTargetAuthoredDragUse,
} as const);

/** Every use `gesture` can select between; the descriptor declares the whole set. */
export const gestureRuntimePlanUses = Object.freeze([
  gesturePlanUse,
  gestureDirectionalFlingUse,
  gestureMultiTouchUse,
  gestureTargetAuthoredDragUse,
] as const);

/** Public `swipe` always normalizes to a one-contact coordinate fling. */
export const swipeRuntimePlanUses = Object.freeze([gesturePlanUse] as const);

/** Every use `scroll` can select between. */
export const scrollRuntimePlanUses = Object.freeze([scrollDirectionUse, scrollEdgeUse] as const);

type GesturePlanFor<Tier extends GestureRuntimeTier> = Readonly<{
  tier: Tier;
  operation: GestureTierOperation<Tier>;
  use: (typeof gestureUsesByTier)[Tier];
}>;

type GestureTierOperation<Tier extends GestureRuntimeTier> =
  (typeof gestureUsesByTier)[Tier]['required'][0];

export type GestureRuntimePlan = {
  [Tier in GestureRuntimeTier]: GesturePlanFor<Tier>;
}[GestureRuntimeTier];

/** Selects the one owner-fact-backed gesture plan a normalized gesture input needs. */
/** Two contacts are what pinch, rotate, transform, and an explicit two-pointer pan all need. */
function isMultiTouchGesture(input: GestureSemanticInput): boolean {
  if (input.intent === 'pan') return ('pointerCount' in input ? input.pointerCount : 1) === 2;
  return input.intent === 'pinch' || input.intent === 'rotate' || input.intent === 'transform';
}

/** Selects the one tier a gesture input needs, so its handler binds exactly once (ADR 0019 §9). */
function gestureRuntimeTier(input: GestureCommandInput): GestureRuntimeTier {
  if (input.intent === 'drag') return 'target-authored-drag';
  if (isMultiTouchGesture(input)) return 'multi-touch';
  // A direction-authored fling carries speed semantics a coordinate fling does not, which is the
  // one thing the Linux drag primitive cannot reproduce.
  if (input.intent === 'fling' && 'direction' in input) return 'directional-fling';
  return 'plan';
}

export function resolveGestureRuntimePlan(input: GestureCommandInput): GestureRuntimePlan {
  const tier = gestureRuntimeTier(input);
  switch (tier) {
    case 'plan':
      return gesturePlan(tier);
    case 'directional-fling':
      return gesturePlan(tier);
    case 'multi-touch':
      return gesturePlan(tier);
    case 'target-authored-drag':
      return gesturePlan(tier);
  }
}

function gesturePlan<const Tier extends GestureRuntimeTier>(tier: Tier): GesturePlanFor<Tier> {
  const use = gestureUsesByTier[tier];
  return Object.freeze({
    tier,
    operation: use.required[0] as GestureTierOperation<Tier>,
    use,
  });
}

/**
 * The edge travels WITH the discriminant so a caller that narrows to `edge` also has the edge
 * itself — that is what lets its execution closure be typed on a binding whose `captureSnapshot`
 * is non-optional, instead of widening both branches and re-proving the capture at runtime.
 */
export type ScrollRuntimePlan =
  | Readonly<{ kind: 'direction'; use: typeof scrollDirectionUse }>
  | Readonly<{ kind: 'edge'; edge: 'top' | 'bottom'; use: typeof scrollEdgeUse }>;

/** `scroll top`/`scroll bottom` verify between passes; every other scroll executes one pass. */
export function resolveScrollRuntimePlan(
  input: Readonly<{ edge?: 'top' | 'bottom' }>,
): ScrollRuntimePlan {
  return input.edge === undefined
    ? Object.freeze({ kind: 'direction', use: scrollDirectionUse } as const)
    : Object.freeze({ kind: 'edge', edge: input.edge, use: scrollEdgeUse } as const);
}
const captureSnapshotWithCustomActionsUse = defineUse({
  required: ['captureSnapshot', 'captureSnapshotWithCustomActions'],
});
const captureSnapshotWithoutActiveAppUse = defineUse({
  required: ['captureSnapshot', 'captureSnapshotWithoutActiveApp'],
});
const captureSnapshotWithCustomActionsWithoutActiveAppUse = defineUse({
  required: [
    'captureSnapshot',
    'captureSnapshotWithCustomActions',
    'captureSnapshotWithoutActiveApp',
  ],
});

const selectorCaptureUse = defineUse({
  required: ['captureSnapshot'],
});
const selectorCaptureWithoutActiveAppUse = defineUse({
  required: ['captureSnapshot', 'captureSnapshotWithoutActiveApp'],
});

/** `get` and read-only `find` may improve a captured result with a live element read. */
const selectorTextCaptureUse = defineUse({
  required: ['captureSnapshot'],
  preferred: ['readTextAtPoint'],
});
const selectorTextCaptureWithoutActiveAppUse = defineUse({
  required: ['captureSnapshot', 'captureSnapshotWithoutActiveApp'],
  preferred: ['readTextAtPoint'],
});

/**
 * Native wait observations are correctness-bearing only for owners that advertise them. They stay
 * out of capture-only and element-text uses so an unrelated command cannot be rejected for a wait
 * operation it never executes (ADR 0019 §2).
 */
const waitSelectorCaptureUse = defineUse({
  required: ['captureSnapshot'],
  conditional: ['findText', 'findSelector'],
});
const waitSelectorCaptureWithoutActiveAppUse = defineUse({
  required: ['captureSnapshot', 'captureSnapshotWithoutActiveApp'],
  conditional: ['findText', 'findSelector'],
});

/**
 * The selector family (`find`, `get`, `is`, `wait`) resolves targets from the plain accessibility
 * capture: it exposes no `--actions` surface, so only the active-app split applies.
 */
export const selectorCaptureRuntimePlanUses = Object.freeze([
  selectorCaptureUse,
  selectorCaptureWithoutActiveAppUse,
] as const);

export const selectorTextCaptureRuntimePlanUses = Object.freeze([
  selectorTextCaptureUse,
  selectorTextCaptureWithoutActiveAppUse,
] as const);

/**
 * `find`'s action-selected mutating uses (ADR 0019 §9: one bind per handler). A mutating find
 * resolves its target from a capture AND executes at most one direct leg, so each action's use
 * carries the complete requirement set and the handler binds exactly once. Click/fill legs
 * re-invoke their own commands, so their use is the plain capture pair.
 */
const findFocusCaptureUse = defineUse({ required: ['captureSnapshot', 'focusPoint'] });
const findFocusCaptureWithoutActiveAppUse = defineUse({
  required: ['captureSnapshot', 'captureSnapshotWithoutActiveApp', 'focusPoint'],
});
const findTypeCaptureUse = defineUse({
  required: ['captureSnapshot', 'focusPoint', 'typeText'],
});
const findTypeCaptureWithoutActiveAppUse = defineUse({
  required: ['captureSnapshot', 'captureSnapshotWithoutActiveApp', 'focusPoint', 'typeText'],
});

/**
 * `find`'s complete use set: the selector-text plans it shares with `get` for its read-only
 * legs, the plain capture pair for target resolution ahead of delegated click/fill, and the
 * action-selected combined uses for the focus and type legs it executes directly.
 */
export const findRuntimePlanUses = Object.freeze([
  selectorTextCaptureUse,
  selectorTextCaptureWithoutActiveAppUse,
  selectorCaptureUse,
  selectorCaptureWithoutActiveAppUse,
  findFocusCaptureUse,
  findFocusCaptureWithoutActiveAppUse,
  findTypeCaptureUse,
  findTypeCaptureWithoutActiveAppUse,
] as const);

export const waitSelectorCaptureRuntimePlanUses = Object.freeze([
  waitSelectorCaptureUse,
  waitSelectorCaptureWithoutActiveAppUse,
] as const);

export const snapshotRuntimePlanUses = Object.freeze([
  captureSnapshotUse,
  captureSnapshotWithCustomActionsUse,
  captureSnapshotWithoutActiveAppUse,
  captureSnapshotWithCustomActionsWithoutActiveAppUse,
] as const);

export type SnapshotRuntimePlan =
  | Readonly<{
      kind: 'active-app';
      operation: 'captureSnapshot';
      use: typeof captureSnapshotUse;
    }>
  | Readonly<{
      kind: 'custom-actions-active-app';
      operation: 'captureSnapshotWithCustomActions';
      use: typeof captureSnapshotWithCustomActionsUse;
    }>
  | Readonly<{
      kind: 'custom-actions-without-active-app';
      operation: 'captureSnapshotWithCustomActions';
      use: typeof captureSnapshotWithCustomActionsWithoutActiveAppUse;
    }>
  | Readonly<{
      kind: 'without-active-app';
      operation: 'captureSnapshotWithoutActiveApp';
      use: typeof captureSnapshotWithoutActiveAppUse;
    }>;

const selectorUsesByIntent = Object.freeze({
  'capture-only': selectorCaptureRuntimePlanUses,
  'element-text': selectorTextCaptureRuntimePlanUses,
  'wait-observation': waitSelectorCaptureRuntimePlanUses,
  // find's action-selected mutating intents: one combined use per directly-executed leg.
  'find-focus': Object.freeze([findFocusCaptureUse, findFocusCaptureWithoutActiveAppUse] as const),
  'find-type': Object.freeze([findTypeCaptureUse, findTypeCaptureWithoutActiveAppUse] as const),
} as const);

export type SelectorCaptureRuntimeIntent = keyof typeof selectorUsesByIntent;

/**
 * Same two `kind`s the snapshot plan uses for this split — deliberately, so capture-only,
 * element-text, and wait-observation callers share one admit-then-bind path.
 */
type SelectorCapturePlanFor<Intent extends SelectorCaptureRuntimeIntent> =
  | Readonly<{
      kind: 'selector-active-app';
      intent: Intent;
      operation: 'captureSnapshot';
      use: (typeof selectorUsesByIntent)[Intent][0];
    }>
  | Readonly<{
      kind: 'selector-without-active-app';
      intent: Intent;
      operation: 'captureSnapshotWithoutActiveApp';
      use: (typeof selectorUsesByIntent)[Intent][1];
    }>;

export type SelectorCaptureRuntimePlan = {
  [Intent in SelectorCaptureRuntimeIntent]: SelectorCapturePlanFor<Intent>;
}[SelectorCaptureRuntimeIntent];

/**
 * The active-app split every selector capture selects from. The selector family exposes no
 * `--actions` surface, so custom actions are outside its declaration.
 */
export function resolveSelectorCaptureRuntimePlan(
  input: Readonly<{
    hasActiveApp: boolean;
    intent: SelectorCaptureRuntimeIntent;
  }>,
): SelectorCaptureRuntimePlan {
  switch (input.intent) {
    case 'capture-only':
      return selectorCapturePlan(
        input.hasActiveApp,
        input.intent,
        selectorUsesByIntent[input.intent],
      );
    case 'element-text':
      return selectorCapturePlan(
        input.hasActiveApp,
        input.intent,
        selectorUsesByIntent[input.intent],
      );
    case 'wait-observation':
      return selectorCapturePlan(
        input.hasActiveApp,
        input.intent,
        selectorUsesByIntent[input.intent],
      );
    case 'find-focus':
      return selectorCapturePlan(
        input.hasActiveApp,
        input.intent,
        selectorUsesByIntent[input.intent],
      );
    case 'find-type':
      return selectorCapturePlan(
        input.hasActiveApp,
        input.intent,
        selectorUsesByIntent[input.intent],
      );
  }
}

function selectorCapturePlan<const Intent extends SelectorCaptureRuntimeIntent>(
  hasActiveApp: boolean,
  intent: Intent,
  uses: (typeof selectorUsesByIntent)[Intent],
): SelectorCapturePlanFor<Intent> {
  return hasActiveApp
    ? Object.freeze({
        kind: 'selector-active-app',
        intent,
        operation: 'captureSnapshot',
        use: uses[0],
      })
    : Object.freeze({
        kind: 'selector-without-active-app',
        intent,
        operation: 'captureSnapshotWithoutActiveApp',
        use: uses[1],
      });
}

/** Selects one owner-fact-backed capture plan from normalized command/session intent. */
export function resolveSnapshotRuntimePlan(input: {
  customActions: boolean;
  hasActiveApp: boolean;
}): SnapshotRuntimePlan {
  if (!input.customActions) {
    return input.hasActiveApp
      ? Object.freeze({ kind: 'active-app', operation: 'captureSnapshot', use: captureSnapshotUse })
      : Object.freeze({
          kind: 'without-active-app',
          operation: 'captureSnapshotWithoutActiveApp',
          use: captureSnapshotWithoutActiveAppUse,
        });
  }
  return input.hasActiveApp
    ? Object.freeze({
        kind: 'custom-actions-active-app',
        operation: 'captureSnapshotWithCustomActions',
        use: captureSnapshotWithCustomActionsUse,
      })
    : Object.freeze({
        kind: 'custom-actions-without-active-app',
        operation: 'captureSnapshotWithCustomActions',
        use: captureSnapshotWithCustomActionsWithoutActiveAppUse,
      });
}

const captureScreenshotUse = defineUse({ required: ['captureScreenshot'] });
/**
 * `--overlay-refs` annotates the capture with the refs of a snapshot taken in the same request, so
 * the snapshot is part of what the command requires — not something to discover after the PNG is
 * already on disk. Declaring it in the use is what lets admission refuse the whole request up
 * front on a target that can capture pixels but not a tree.
 */
const captureScreenshotWithOverlayRefsUse = defineUse({
  required: ['captureScreenshot', 'captureSnapshot'],
});

export const screenshotRuntimePlanUses = Object.freeze([
  captureScreenshotUse,
  captureScreenshotWithOverlayRefsUse,
] as const);

export type ScreenshotRuntimePlan =
  | Readonly<{ kind: 'capture'; use: typeof captureScreenshotUse }>
  | Readonly<{
      kind: 'capture-with-overlay-refs';
      use: typeof captureScreenshotWithOverlayRefsUse;
    }>;

/** Selects one owner-fact-backed capture plan from normalized command intent. */
export function resolveScreenshotRuntimePlan(
  input: Readonly<{ overlayRefs: boolean }>,
): ScreenshotRuntimePlan {
  return input.overlayRefs
    ? Object.freeze({
        kind: 'capture-with-overlay-refs',
        use: captureScreenshotWithOverlayRefsUse,
      })
    : Object.freeze({ kind: 'capture', use: captureScreenshotUse });
}
export const deviceBootRuntimeUses = Object.freeze([bootTargetUse, bootTargetHeadlessUse] as const);

export type DeviceReadinessRuntimePlan =
  | Readonly<{
      kind: 'boot-target';
      operation: 'bootTarget';
      use: typeof bootTargetUse;
    }>
  | Readonly<{
      kind: 'boot-target-headless';
      operation: 'bootTargetHeadless';
      use: typeof bootTargetHeadlessUse;
    }>;

const bootTargetPlan = Object.freeze({
  kind: 'boot-target',
  operation: 'bootTarget',
  use: bootTargetUse,
} as const satisfies DeviceReadinessRuntimePlan);

const bootTargetHeadlessPlan = Object.freeze({
  kind: 'boot-target-headless',
  operation: 'bootTargetHeadless',
  use: bootTargetHeadlessUse,
} as const satisfies DeviceReadinessRuntimePlan);

export function resolveDeviceReadinessRuntimePlan(
  input: Readonly<{
    headless: boolean;
  }>,
): DeviceReadinessRuntimePlan {
  return input.headless ? bootTargetHeadlessPlan : bootTargetPlan;
}
export const appStateUse = defineUse({ required: ['ensureReady', 'appState'] });
export const appStateRuntimeUses = Object.freeze([appStateUse] as const);

export const shutdownTargetUse = defineUse({ required: ['shutdownTarget'] });

/**
 * `clipboard`'s action-selected uses (ADR 0019 §9: one bind per handler). `read` and `write` are
 * separate cells because an owner can genuinely have one without the other, so the daemon's
 * `session-clipboard.ts` admits and binds exactly the one the parsed subcommand names.
 */
export const clipboardRuntimePlanUses = Object.freeze([
  clipboardReadUse,
  clipboardWriteUse,
] as const);

/**
 * `alert`'s action-selected uses (ADR 0019 §9: one bind per handler). The four legs differ in
 * what they do to the device — one observes, one waits, two press a button — so the daemon's
 * `snapshot-alert.ts` admits and binds exactly the one the parsed subcommand names.
 */
export const alertRuntimePlanUses = Object.freeze([
  alertReadUse,
  alertWaitUse,
  alertAcceptUse,
  alertDismissUse,
] as const);

/**
 * `keyboard`'s action-selected uses (ADR 0019 §9: one bind per handler). `status` is Android-only
 * (parity with the retired leaf's per-family rejection of `status`/`get` everywhere else);
 * `dismiss` and `enter` are the cross-platform legs. The daemon's `keyboard-runtime.ts` admits
 * and binds exactly one of the three exported uses per request, keyed by the parsed action —
 * never all three.
 */
export const keyboardRuntimePlanUses = Object.freeze([
  keyboardStatusUse,
  keyboardDismissUse,
  keyboardEnterUse,
] as const);

export type PlatformRuntimeHost = AppLogRuntimeHost &
  NetworkRuntimeHost &
  Readonly<{
    appInventory: AppInventoryRuntimeHost;
    appState: AppStateRuntimeHost;
    /** Focused native ports; deployment semantics remain in the owning family packages. */
    appleDeployment: AppleAppDeploymentExecutor;
    androidDeployment: AndroidAppDeploymentExecutor;
    androidTools: AndroidToolHost;
    temporaryFiles: Readonly<{
      create(
        options: Readonly<{ prefix: string; suffix: string }>,
      ): Promise<import('./platform-runtime-host.ts').HostTemporaryTextFile>;
    }>;
    screenRecording: ScreenRecordingRuntimeHost;
    audioProbe: AudioProbeRuntimeHost;
    perf: PerfRuntimeHost;
    snapshot: SnapshotRuntimeHost;
    deviceReadiness: DeviceReadinessRuntimeHost;
    deviceShutdown: DeviceShutdownRuntimeHost;
    localInteractors: LocalApplicationInteractorHost;
    appleApplications: AppleApplicationTools;
    androidApplications: AndroidApplicationTools;
    applicationResources: ApplicationLifecycleResourceLifecycle;
  }>;

export type PlatformRuntimeOwner = DeviceRuntimeOwner<PlatformRuntimeOperations>;

export type PlatformRuntimeModule = RuntimePlatformModule<
  PlatformRuntimeOperations,
  PlatformRuntimeHost
>;

/** Cheap exact-owner metadata stays eager; provider mechanics remain lazy until selection. */
export type PlatformRuntimeProviderModule = Readonly<{
  owner: Extract<RuntimeOwnerRef, { kind: 'provider-runtime' }>;
  loadRuntime(host: PlatformRuntimeHost): Promise<PlatformRuntimeOwner>;
}>;
