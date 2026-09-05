import { expect, vi } from 'vitest';
import {
  localRuntimeOwner,
  type RuntimeFacts,
  type RuntimeOperationKey,
  type RuntimeOperationUnavailability,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { commandRuntimeUseRequirements } from '../../core/command-descriptor/registry.ts';
import { createUnavailableRuntimeFactsForTest } from '../../__tests__/test-utils/runtime-operation-facts.ts';
import { makeSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { resolveBoundAppSwitcherRuntime } from '../app-switcher-runtime.ts';
import { resolveBoundBackRuntime } from '../back-runtime.ts';
import { resolveBoundFocusRuntime } from '../focus-runtime.ts';
import { resolveBoundGestureRuntime } from '../gesture-runtime.ts';
import { resolveBoundHomeRuntime } from '../home-runtime.ts';
import { resolveBoundOrientationRuntime } from '../orientation-runtime.ts';
import type { ResolvedGenericExecution } from '../request-generic-dispatch.ts';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
  RuntimeAdmissionBindings,
} from '../request-runtime-binding.ts';
import type { DaemonFailureResponse } from '../response.ts';
import { dispatchSnapshotDiffViaRuntime } from '../snapshot-diff-runtime.ts';
import { resolveBoundTvRemoteRuntime } from '../tv-remote-runtime.ts';
import { resolveBoundTypeTextRuntime } from '../type-text-runtime.ts';
import { resolveBoundViewportRuntime } from '../viewport-runtime.ts';

type RuntimeOperation = RuntimeOperationKey<PlatformRuntimeOperations>;

/** What an admission-first route reports: a refusal carries the response and no binding. */
export type RefusableResolution =
  | Readonly<{ ok: false; response: DaemonFailureResponse }>
  | Readonly<{ ok: true }>;

type ConformedRuntimeBinding = Readonly<{
  /** Resolves the route against the given admission seams with the inputs its parser accepts. */
  resolve: (
    device: DeviceInfo,
    bindings: Required<RuntimeAdmissionBindings>,
  ) => Promise<RefusableResolution>;
  /**
   * A plan route admits several declared cells in order; name the one this table refuses on and
   * the ones the plan admits before reaching it. A single-use route derives its one cell from the
   * command registry instead.
   */
  plan?: Readonly<{ refused: RuntimeOperation; admitted: readonly RuntimeOperation[] }>;
}>;

const available = Object.freeze({ available: true } as const);

/**
 * A generic-route resolver's failure branch carries the wire-level `DaemonResponse` union rather
 * than the narrower `DaemonFailureResponse` its `ok: false` already guarantees. This proves that
 * guarantee once (throwing if a resolver ever broke it) instead of casting it away at each call
 * site below.
 */
function refusable(resolved: ResolvedGenericExecution): RefusableResolution {
  if (resolved.ok) return { ok: true };
  if (resolved.response.ok) {
    throw new Error('a refusal reported an ok response');
  }
  return { ok: false, response: resolved.response };
}

/**
 * Every daemon route whose refusal on an unavailable exact-owner fact is proven through the shared
 * conformance helper, keyed by registry command name. `runtime-binding-conformance-completeness`
 * checks this table against the registry's runtime-use declarations in both directions.
 */
export const conformedRuntimeBindings = {
  back: {
    resolve: async (device, bindings) =>
      refusable(await resolveBoundBackRuntime({ device, ...bindings })),
  },
  home: {
    resolve: async (device, bindings) =>
      refusable(await resolveBoundHomeRuntime({ device, ...bindings })),
  },
  'app-switcher': {
    resolve: async (device, bindings) =>
      refusable(await resolveBoundAppSwitcherRuntime({ device, ...bindings })),
  },
  focus: {
    resolve: async (device, bindings) =>
      refusable(await resolveBoundFocusRuntime({ device, positionals: ['40', '90'], ...bindings })),
  },
  viewport: {
    resolve: async (device, bindings) =>
      refusable(
        await resolveBoundViewportRuntime({ device, positionals: ['1280', '900'], ...bindings }),
      ),
  },
  orientation: {
    resolve: async (device, bindings) =>
      refusable(
        await resolveBoundOrientationRuntime({
          device,
          positionals: ['landscape-left'],
          ...bindings,
        }),
      ),
  },
  'tv-remote': {
    resolve: async (device, bindings) =>
      refusable(await resolveBoundTvRemoteRuntime({ device, positionals: ['down'], ...bindings })),
  },
  type: {
    resolve: (device, bindings) => resolveBoundTypeTextRuntime({ device, ...bindings }),
  },
  swipe: {
    // A swipe always normalizes to the coordinate-fling plan tier (R54), which requires both
    // cells in order: `performGesturePlan` admitted, then `captureSnapshot` refused.
    plan: { refused: 'captureSnapshot', admitted: ['performGesturePlan'] },
    resolve: (device, bindings) =>
      resolveBoundGestureRuntime({
        device,
        input: { intent: 'fling', from: { x: 10, y: 500 }, to: { x: 10, y: 100 } },
        ...bindings,
      }),
  },
  diff: {
    plan: { refused: 'captureSnapshotWithCustomActions', admitted: ['captureSnapshot'] },
    resolve: async (device, bindings) => {
      const sessionStore = makeSessionStore('agent-device-runtime-binding-conformance-');
      const session = makeSession('diff-runtime', { device, appBundleId: 'com.example.app' });
      sessionStore.set(session.name, session);
      const response = await dispatchSnapshotDiffViaRuntime({
        req: {
          command: 'diff',
          positionals: ['snapshot'],
          token: 't',
          session: session.name,
          flags: { snapshotCustomActions: true },
        },
        sessionName: session.name,
        logPath: '/tmp/diff-runtime.log',
        sessionStore,
        ...bindings,
      });
      return response.ok ? { ok: true } : { ok: false, response };
    },
  },
} satisfies Record<string, ConformedRuntimeBinding>;

export type ConformedRuntimeCommand = keyof typeof conformedRuntimeBindings;

/** The one cell a route refuses on: the plan's named cell, or the registry's single declaration. */
export function refusedRuntimeOperation(command: ConformedRuntimeCommand): RuntimeOperation {
  const binding: ConformedRuntimeBinding = conformedRuntimeBindings[command];
  if (binding.plan) return binding.plan.refused;
  const uses = commandRuntimeUseRequirements(command);
  const required = uses?.length === 1 ? uses[0] : undefined;
  if (required?.length !== 1) {
    throw new Error(
      `${command} declares no single runtime operation in the command registry; name the refused cell in its conformance plan`,
    );
  }
  return required[0] as RuntimeOperation;
}

export type UnavailableExactOwnerFactCase = Readonly<{
  command: ConformedRuntimeCommand;
  device: DeviceInfo;
  unavailable: RuntimeOperationUnavailability;
}>;

/**
 * Drives the route with exactly one exact-owner cell unavailable and returns the refusal it
 * reported. Facts are inspected once and the device is never bound: admission refuses before any
 * owner is reached.
 */
export async function refuseUnavailableExactOwnerFact(
  testCase: UnavailableExactOwnerFactCase,
): Promise<DaemonFailureResponse> {
  const binding: ConformedRuntimeBinding = conformedRuntimeBindings[testCase.command];
  const base = createUnavailableRuntimeFactsForTest(
    testCase.device,
    localRuntimeOwner(testCase.device.platform),
  );
  const admitted = Object.fromEntries(
    (binding.plan?.admitted ?? []).map((operation) => [operation, available]),
  );
  const facts: RuntimeFacts<PlatformRuntimeOperations> = {
    device: base.device,
    operations: {
      ...base.operations,
      ...admitted,
      [refusedRuntimeOperation(testCase.command)]: testCase.unavailable,
    },
  };
  const inspectFacts: InspectDeviceRuntimeFacts = vi.fn(async () => facts);
  const bindDevice = vi.fn() as unknown as BindDeviceRuntime;

  const resolved = await binding.resolve(testCase.device, { inspectFacts, bindDevice });

  expect(inspectFacts).toHaveBeenCalledTimes(1);
  expect(inspectFacts).toHaveBeenCalledWith(testCase.device);
  expect(bindDevice).not.toHaveBeenCalled();
  expect(resolved.ok).toBe(false);
  if (resolved.ok) throw new Error(`${testCase.command} admitted an unavailable exact-owner cell`);
  return resolved.response;
}

/** The wording `admitRuntimeOperations` gives every single-use route it refuses. */
function unsupportedOperationRefusal(
  command: ConformedRuntimeCommand,
  unavailable: RuntimeOperationUnavailability,
): DaemonFailureResponse['error'] {
  return {
    code: 'UNSUPPORTED_OPERATION',
    message: `${command} is not supported on this device`,
    ...(unavailable.hint ? { hint: unavailable.hint } : {}),
  };
}

/**
 * The family conformance check: the route refuses before binding and reports exactly the
 * expected error. A route that shapes its own refusal passes it as `refusal`; the rest inherit the
 * shared unsupported-operation wording.
 */
export async function expectRefusesUnavailableExactOwnerFact(
  testCase: UnavailableExactOwnerFactCase & Readonly<{ refusal?: DaemonFailureResponse['error'] }>,
): Promise<void> {
  const response = await refuseUnavailableExactOwnerFact(testCase);
  expect(response.error).toEqual(
    testCase.refusal ?? unsupportedOperationRefusal(testCase.command, testCase.unavailable),
  );
}
