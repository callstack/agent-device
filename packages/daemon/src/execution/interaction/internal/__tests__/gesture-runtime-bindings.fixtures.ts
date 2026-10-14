import { vi, type Mock } from 'vitest';
import type { BoundDeviceRuntime, RuntimeFacts } from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import type { Rect } from '@agent-device/kernel/snapshot';
import type {
  GesturePlanInput,
  GestureViewportInput,
} from '@agent-device/contracts/gesture-runtime';
import type {
  CaptureSnapshotInput,
  SnapshotResult,
} from '@agent-device/contracts/snapshot-runtime';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../../../core/request-runtime-binding.ts';
import { unavailableDeploymentSnapshotAndShutdownOperationFacts } from '@agent-device/test-kit/runtime-operation-facts';

const available = Object.freeze({ available: true } as const);

/**
 * A runtime that admits every gesture tier, with one spy per operation.
 *
 * The counters on `inspectFacts` / `bindDevice` are the ADR 0019 §9 regression surface: a handler
 * that binds per repetition, or re-inspects after resolving a target, shows up here as a count
 * greater than one (the defect #1944's P1 fixed).
 */
export function gestureRuntimeBindingsFixture(
  options: Readonly<{ viewport?: Rect; unavailable?: readonly string[] }> = {},
) {
  const unavailable = new Set(options.unavailable ?? []);
  const cell = (operation: string) =>
    unavailable.has(operation)
      ? ({ available: false, reason: 'unsupported-platform-leaf' } as const)
      : available;
  const operationSpies = {
    captureSnapshot: vi.fn(async () => ({
      backend: 'xctest' as const,
      nodes: [],
    })) as unknown as Mock<(input: CaptureSnapshotInput) => Promise<SnapshotResult>>,
    performGesturePlan: vi.fn(async () => ({})) as Mock<
      (input: GesturePlanInput) => Promise<Record<string, never>>
    >,
    performDirectionalFlingPlan: vi.fn(async () => ({})) as Mock<
      (input: GesturePlanInput) => Promise<Record<string, never>>
    >,
    performMultiTouchGesturePlan: vi.fn(async () => ({})) as Mock<
      (input: GesturePlanInput) => Promise<Record<string, never>>
    >,
    performTargetAuthoredDrag: vi.fn(async () => ({})) as Mock<
      (input: GesturePlanInput) => Promise<Record<string, never>>
    >,
    gestureViewport: vi.fn(
      async () => options.viewport ?? { x: 0, y: 0, width: 400, height: 800 },
    ) as Mock<(input: GestureViewportInput) => Promise<Rect>>,
  };
  const facts = {
    device: { family: 'apple', kind: 'simulator', providerMode: 'local' },
    operations: {
      ...unavailableDeploymentSnapshotAndShutdownOperationFacts,
      captureSnapshot: cell('captureSnapshot'),
      performGesturePlan: cell('performGesturePlan'),
      performDirectionalFlingPlan: cell('performDirectionalFlingPlan'),
      performMultiTouchGesturePlan: cell('performMultiTouchGesturePlan'),
      performTargetAuthoredDrag: cell('performTargetAuthoredDrag'),
      gestureViewport: cell('gestureViewport'),
    },
  } as unknown as RuntimeFacts<PlatformRuntimeOperations>;
  const inspectFacts = vi.fn(async () => facts) as unknown as InspectDeviceRuntimeFacts &
    Mock<() => Promise<RuntimeFacts<PlatformRuntimeOperations>>>;
  const bindDevice = vi.fn(
    async () =>
      ({
        facts,
        operations: Object.fromEntries(
          Object.entries(operationSpies).filter(([name]) => !unavailable.has(name)),
        ),
      }) as unknown as BoundDeviceRuntime<never>,
  ) as unknown as BindDeviceRuntime & Mock<() => Promise<BoundDeviceRuntime<never>>>;
  return { ...operationSpies, facts, inspectFacts, bindDevice };
}
