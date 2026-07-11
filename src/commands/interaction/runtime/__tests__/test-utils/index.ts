import type { AgentDeviceBackend, BackendSnapshotResult } from '../../../../../backend.ts';
import { createLocalArtifactAdapter } from '../../../../../io.ts';
import type { SnapshotState } from '../../../../../kernel/snapshot.ts';
import {
  createAgentDevice,
  createMemorySessionStore,
  localCommandPolicy,
  type CommandSessionStore,
} from '../../../../../runtime.ts';
import { ref } from '../../../../index.ts';
import { makeSnapshotState } from '../../../../../__tests__/test-utils/index.ts';

export function selectorSnapshot(): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Button',
      label: 'Continue',
      value: 'Continue',
      rect: { x: 10, y: 20, width: 100, height: 40 },
      hittable: true,
    },
  ]);
}

// Closed-drawer shape shared by the native-ref preflight tests: the only
// interactive node (@e2) sits fully left of the Application viewport.
export function offscreenDrawerSnapshot(): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 400, height: 800 },
      hittable: true,
    },
    {
      index: 1,
      depth: 2,
      parentIndex: 0,
      type: 'Button',
      label: 'Explore',
      rect: { x: -320, y: 240, width: 300, height: 50 },
      hittable: true,
    },
  ]);
}

export function runtimeScrollSnapshot(options: {
  hiddenBelow: boolean;
  message?: string;
}): SnapshotState {
  return makeSnapshotState([
    {
      index: 1,
      depth: 0,
      type: 'ScrollView',
      label: 'Messages',
      hiddenContentBelow: options.hiddenBelow ? true : undefined,
      rect: { x: 0, y: 100, width: 400, height: 600 },
    },
    {
      index: 2,
      depth: 1,
      parentIndex: 1,
      type: 'Button',
      label: options.message ?? 'Latest message',
      rect: { x: 0, y: 640, width: 400, height: 56 },
      hittable: true,
    },
  ]);
}

export function fillableSnapshot(): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'XCUIElementTypeTextField',
      label: 'Email',
      rect: { x: 20, y: 10, width: 60, height: 40 },
      hittable: true,
    },
  ]);
}

export function iosTabBarSnapshot(): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'XCUIElementTypeApplication',
      label: 'TabRepro',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      hittable: false,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeTabBar',
      rect: { x: 0, y: 791, width: 402, height: 83 },
      hittable: true,
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'XCUIElementTypeButton',
      label: 'Home',
      rect: { x: 30, y: 800, width: 91, height: 44 },
      hittable: false,
    },
    {
      index: 3,
      depth: 2,
      parentIndex: 1,
      type: 'XCUIElementTypeButton',
      label: 'Library',
      rect: { x: 120, y: 800, width: 92, height: 44 },
      hittable: false,
    },
    {
      index: 4,
      depth: 2,
      parentIndex: 1,
      type: 'XCUIElementTypeButton',
      label: 'Settings',
      rect: { x: 211, y: 800, width: 91, height: 44 },
      hittable: false,
    },
    {
      index: 5,
      depth: 2,
      parentIndex: 1,
      type: 'XCUIElementTypeButton',
      label: 'Search',
      rect: { x: 304, y: 800, width: 92, height: 44 },
      hittable: false,
    },
  ]);
}

export function coveredByTabBarSnapshot(): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Example',
      rect: { x: 0, y: 0, width: 390, height: 844 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Save draft',
      rect: { x: 16, y: 790, width: 140, height: 44 },
      hittable: false,
      interactionBlocked: 'covered',
      presentationHints: ['covered'],
    },
    {
      index: 2,
      depth: 1,
      parentIndex: 0,
      type: 'TabBar',
      rect: { x: 0, y: 760, width: 390, height: 84 },
      hittable: true,
    },
  ]);
}

export function duplicateCoveredLabelSnapshot(): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Example',
      rect: { x: 0, y: 0, width: 390, height: 844 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Save draft',
      rect: { x: 16, y: 120, width: 140, height: 44 },
      hittable: true,
    },
    {
      index: 2,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Save draft',
      rect: { x: 16, y: 790, width: 140, height: 44 },
      hittable: false,
      interactionBlocked: 'covered',
      presentationHints: ['covered'],
    },
    {
      index: 3,
      depth: 1,
      parentIndex: 0,
      type: 'TabBar',
      rect: { x: 0, y: 760, width: 390, height: 84 },
      hittable: true,
    },
  ]);
}

export function nonHittableCellSnapshot(): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'XCUIElementTypeOther',
      label: 'Settings list',
      rect: { x: 10, y: 20, width: 300, height: 80 },
      hittable: true,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeCell',
      label: 'Account',
      rect: { x: 20, y: 10, width: 100, height: 40 },
      hittable: false,
    },
  ]);
}

// Mirrors the #1037 Maps repro: a non-hittable map-pin annotation exact-matches
// `text="Anthropic - Headquarters"` while the real, longer-labeled row is a
// separate node. Fill/press must still proceed against the unique match (no
// stricter resolution) but should flag it as likely non-actionable.
export function mapPinAnnotationSnapshot(): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Other',
      label: 'Anthropic - Headquarters',
      rect: { x: 177, y: 446, width: 30, height: 30 },
      hittable: false,
    },
    {
      index: 1,
      depth: 1,
      type: 'Button',
      label: 'Anthropic - Headquarters, 548 Market St',
      rect: { x: 0, y: 786, width: 390, height: 60 },
      hittable: false,
    },
  ]);
}

export function nonTouchableGroupSnapshot(): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'XCUIElementTypeOther',
      label: 'Clickable group',
      rect: { x: 10, y: 20, width: 300, height: 80 },
      hittable: true,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeOther',
      label: 'Decorative group',
      rect: { x: 30, y: 40, width: 60, height: 20 },
      hittable: false,
    },
  ]);
}

export function snapshotWithOffscreenContent(): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Example',
      rect: { x: 0, y: 0, width: 100, height: 100 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Visible',
      rect: { x: 10, y: 10, width: 20, height: 20 },
      hittable: true,
    },
    {
      index: 2,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Offscreen',
      rect: { x: 10, y: 900, width: 20, height: 20 },
      hittable: true,
    },
  ]);
}

export function createInteractionDevice(
  snapshot: SnapshotState,
  overrides: Partial<
    Pick<
      AgentDeviceBackend,
      | 'captureSnapshot'
      | 'resolveGestureViewport'
      | 'tap'
      | 'tapTarget'
      | 'fill'
      | 'fillTarget'
      | 'typeText'
      | 'focus'
      | 'longPress'
      | 'scroll'
      | 'performGesture'
    >
  > & {
    platform?: AgentDeviceBackend['platform'];
    sessionMetadata?: Record<string, unknown>;
  } = {},
) {
  return createAgentDevice({
    backend: {
      platform: overrides.platform ?? 'ios',
      captureSnapshot: async (...args) =>
        overrides.captureSnapshot ? await overrides.captureSnapshot(...args) : { snapshot },
      resolveGestureViewport: overrides.resolveGestureViewport
        ? async (...args) => await overrides.resolveGestureViewport?.(...args)
        : undefined,
      tap: async (...args) => await overrides.tap?.(...args),
      tapTarget: overrides.tapTarget
        ? async (...args) => await overrides.tapTarget?.(...args)
        : undefined,
      fill: async (...args) => await overrides.fill?.(...args),
      fillTarget: overrides.fillTarget
        ? async (...args) => await overrides.fillTarget?.(...args)
        : undefined,
      typeText: async (...args) => await overrides.typeText?.(...args),
      focus: overrides.focus ? async (...args) => await overrides.focus?.(...args) : undefined,
      longPress: overrides.longPress
        ? async (...args) => await overrides.longPress?.(...args)
        : undefined,
      scroll: overrides.scroll ? async (...args) => await overrides.scroll?.(...args) : undefined,
      performGesture: overrides.performGesture,
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([
      { name: 'default', snapshot, metadata: overrides.sessionMetadata },
    ]),
    policy: localCommandPolicy(),
  });
}

export async function clickRefE2(device: ReturnType<typeof createInteractionDevice>) {
  return await device.interactions.click(ref('@e2'), {
    session: 'default',
  });
}

export function createFakeClock(stepMs = 300): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
} {
  let elapsed = 0;
  return {
    now: () => elapsed,
    sleep: async (ms: number) => {
      elapsed += ms > 0 ? ms : stepMs;
    },
  };
}

export function selectorReadSnapshot(): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Button',
      label: 'Continue',
      value: 'Continue',
      rect: { x: 10, y: 20, width: 100, height: 40 },
    },
  ]);
}

export function createSelectorDevice(
  snapshot: SnapshotState,
  options: {
    readText?: string;
    findText?: boolean;
    now?: number;
    captureSnapshot?: () => BackendSnapshotResult | Promise<BackendSnapshotResult>;
  } = {},
) {
  const session = { name: 'default', snapshot };
  const sessions = {
    get: () => session,
    set: (record) => {
      session.snapshot = record.snapshot ?? session.snapshot;
    },
  } satisfies CommandSessionStore;
  return createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async () =>
        options.captureSnapshot ? await options.captureSnapshot() : { snapshot },
      readText: async () => ({ text: options.readText ?? '' }),
      findText: async () => ({ found: options.findText ?? false }),
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions,
    policy: localCommandPolicy(),
    clock: {
      now: () => options.now ?? 0,
      sleep: async () => {},
    },
  });
}
