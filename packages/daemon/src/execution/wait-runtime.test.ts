import { daemonPlatformServicesFixture } from '../__tests__/support/platform-services-fixture.ts';
import { expect, test, vi } from 'vitest';
import { WAIT_REASONS } from '@agent-device/contracts/wait';
import { AppError } from '@agent-device/kernel/errors';
import {
  type DeviceBinding,
  type RuntimeFacts,
  type RuntimeOperationFact,
  localRuntimeOwner,
  narrowDeviceBinding,
  providerRuntimeOwner,
} from '@agent-device/contracts/platform-runtime';
import {
  type PlatformRuntimeOperations,
  waitSelectorCaptureRuntimePlanUses,
} from '@agent-device/contracts/platform-runtime-operations';
import type { FindTextInput } from '@agent-device/contracts/selector-observation-runtime';
import {
  type CaptureSnapshotInput,
  type SnapshotResult,
  snapshotRuntimeOperationFacts,
} from '@agent-device/contracts/snapshot-runtime';
import { commandSurfaceWithMembers } from '../__tests__/support/command-surface-override-fake.ts';
import { deviceShape, type DeviceInfo } from '@agent-device/kernel/device';
import { makeSession } from '../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../__tests__/support/store-factory.ts';
import { unavailableDeploymentSnapshotAndShutdownOperationFacts } from '@agent-device/test-kit';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../core/request-runtime-binding.ts';
import { handleSnapshotCommands } from '../sessions/handlers/snapshot.ts';
import { resolveBoundSelectorCapture } from './selector-capture-binding.ts';
import type { DaemonRequest } from '../index.ts';

const testCreateCommandSurface = commandSurfaceWithMembers((config) => ({
  selectors: {
    wait: async ({ target, session, requestId, signal }) => {
      if (target.kind === 'sleep') {
        await new Promise<void>((resolve) => setTimeout(resolve, target.durationMs));
        return { kind: 'sleep', waitedMs: target.durationMs };
      }
      const context = { session, requestId, signal: signal ?? config.signal };
      if (target.kind === 'text') {
        const native = await config.backend.findText?.(context, target.text);
        if (native?.found) return { kind: 'text', text: target.text, waitedMs: 0 };
      }
      await config.backend.captureSnapshot?.(context, {});
      if (target.kind === 'text' && target.timeoutMs === 1) {
        throw new AppError('COMMAND_FAILED', `wait timed out for text: ${target.text}`, {
          reason: WAIT_REASONS.targetAbsent,
        });
      }
      return {
        kind: target.kind === 'ref' ? 'text' : target.kind,
        waitedMs: 0,
        ...(target.kind === 'text' || target.kind === 'ref' ? { text: 'Ready' } : {}),
        ...(target.kind === 'selector' || target.kind === 'absent'
          ? { selector: target.selector }
          : {}),
        ...(target.kind === 'stable' ? { captures: 1 } : {}),
      };
    },
  },
}));

const webDevice = {
  id: 'web',
  name: 'Web',
  platform: 'web',
  kind: 'device',
  booted: true,
} as const satisfies DeviceInfo;

const available = Object.freeze({ available: true } as const);
/** The harness session tracks no app bundle id, so wait's plan is the without-active-app one. */
const waitWithoutActiveAppUse = waitSelectorCaptureRuntimePlanUses[1];

const findTextUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf' as const,
  hint: 'This target exposes no native text reading.',
});
const captureUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf' as const,
  hint: 'wait observes a snapshot; this target exposes none.',
});

type CaptureNode = {
  index: number;
  depth: number;
  type: string;
  label?: string;
  hittable?: boolean;
};

/**
 * Binds the fake at the seam the handler consumes — `inspectFacts` / `bindDevice` — never at
 * `-device/device-selection/dispatch-resolve`. `captureSnapshot` is the ONE operation `wait` declares, so this harness is
 * also the proof that no sibling snapshot operation is reachable from wait's narrowed binding.
 */
function waitRuntimeHarness(
  options: {
    capture?: RuntimeOperationFact;
    device?: DeviceInfo;
    providerOwned?: boolean;
    nodesPerPoll?: CaptureNode[][];
    /** The owner's native text reading; absent means the owner advertises none. */
    findText?: RuntimeOperationFact;
    findTextAnswers?: (text: string) => boolean;
    /** A scenario-supplied capture operation, for poll-deadline behaviour. */
    captureSnapshot?: (input: CaptureSnapshotInput) => Promise<SnapshotResult>;
  } = {},
) {
  const device = options.device ?? webDevice;
  const capture = options.capture ?? available;
  const polls = options.nodesPerPoll ?? [
    [{ index: 0, depth: 0, type: 'Button', label: 'Ready', hittable: true }],
  ];
  let pollIndex = 0;

  const captureSnapshot = vi.fn(async (input: CaptureSnapshotInput): Promise<SnapshotResult> =>
    options.captureSnapshot
      ? await options.captureSnapshot(input)
      : {
          nodes: polls[Math.min(pollIndex++, polls.length - 1)] ?? [],
          backend: 'web',
          producer: 'agent-browser',
        },
  );
  const findTextFact = options.findText ?? findTextUnavailable;
  const findText = vi.fn(async (input: FindTextInput) => ({
    found: options.findTextAnswers?.(input.text) ?? false,
  }));
  const facts: RuntimeFacts<PlatformRuntimeOperations> = {
    device: {
      ...deviceShape(device),
      providerMode: options.providerOwned ? 'provider-runtime' : 'local',
    },
    operations: {
      ...unavailableDeploymentSnapshotAndShutdownOperationFacts,
      ...snapshotRuntimeOperationFacts({
        capture,
        customActions: captureUnavailable,
        withoutActiveApp: capture,
      }),
      findText: findTextFact,
    } as RuntimeFacts<PlatformRuntimeOperations>['operations'],
  };
  const binding = {
    device,
    owner: options.providerOwned
      ? providerRuntimeOwner('test', 'wait-runtime-test')
      : localRuntimeOwner(device.platform),
    facts,
    operations: {
      captureSnapshot,
      captureSnapshotWithCustomActions: captureSnapshot,
      captureSnapshotWithoutActiveApp: captureSnapshot,
      // Only advertised operations get an implementation, so an owner whose facts refuse
      // `findText` cannot expose one through the narrowed projection either.
      ...(findTextFact.available ? { findText } : {}),
    },
    [Symbol.asyncDispose]: async () => {},
  } as unknown as DeviceBinding<PlatformRuntimeOperations>;

  const inspectFacts: InspectDeviceRuntimeFacts = vi.fn(async () => facts);
  const bindDevice = vi.fn(async (_device, use) =>
    narrowDeviceBinding(binding, use),
  ) as unknown as BindDeviceRuntime;
  return { device, captureSnapshot, findText, inspectFacts, bindDevice, facts };
}

function waitRequest(positionals: string[], flags: Record<string, unknown> = {}): DaemonRequest {
  return {
    command: 'wait',
    positionals,
    token: 't',
    session: 'wait-runtime',
    flags,
    meta: { requestId: 'wait-runtime-test' },
  } as unknown as DaemonRequest;
}

test.each(['rebuild', 'retire'] as const)(
  'sleep-only wait records in its admitted lifetime across %s',
  async (transition) => {
    vi.useFakeTimers();
    try {
      const harness = waitRuntimeHarness();
      const sessionStore = makeSessionStore();
      const address = 'cwd:sleep-wait:default';
      const ref = sessionStore.publish(address, makeSession('default', { device: harness.device }));
      const running = handleSnapshotCommands({
        createCommandSurface: testCreateCommandSurface,
        platformServices: daemonPlatformServicesFixture(),
        req: waitRequest(['100']),
        sessionName: address,
        logPath: '/tmp/daemon.log',
        sessionStore,
        inspectFacts: harness.inspectFacts,
        bindDevice: harness.bindDevice,
      });
      await vi.advanceTimersByTimeAsync(0);
      let current = ref.session;
      if (transition === 'rebuild') {
        current = sessionStore.update(ref, { actions: [], appName: 'Updated during sleep' });
      } else {
        sessionStore.retire(ref);
        current = sessionStore.publish(
          address,
          makeSession('default', { device: harness.device }),
        ).session;
      }
      await vi.advanceTimersByTimeAsync(100);
      const response = await running;
      expect(harness.captureSnapshot).not.toHaveBeenCalled();
      if (transition === 'rebuild') {
        expect(response?.ok).toBe(true);
        expect(current.actions.map((action) => action.command)).toEqual(['wait']);
        expect(ref.session.actions).toEqual([]);
        expect(current.appName).toBe('Updated during sleep');
      } else {
        expect(response).toMatchObject({ ok: true, data: { waitedMs: 100 } });
        expect(ref.session.actions).toEqual([]);
        expect(current.actions).toEqual([]);
      }
    } finally {
      vi.useRealTimers();
    }
  },
);

async function runWait(
  positionals: string[],
  harness: ReturnType<typeof waitRuntimeHarness>,
  sessionNodes: CaptureNode[] = [],
  flags: Record<string, unknown> = {},
) {
  const sessionStore = makeSessionStore('agent-device-wait-runtime-');
  const session = makeSession('wait-runtime', { device: harness.device });
  if (sessionNodes.length > 0) {
    session.snapshot = {
      nodes: sessionNodes.map((node) => ({ ...node, ref: `e${node.index + 1}` })),
      createdAt: Date.now(),
      backend: 'web',
    } as unknown as NonNullable<typeof session.snapshot>;
  }
  sessionStore.publish(session.name, session);
  const response = await handleSnapshotCommands({
    createCommandSurface: testCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: waitRequest(positionals, flags),
    sessionName: session.name,
    logPath: '/tmp/daemon.log',
    sessionStore,
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });
  if (!response) throw new Error('the snapshot route did not handle wait');
  return { response, session, sessionStore };
}

// ---------------------------------------------------------------------------
// The duration shape. It is the one wait shape that reaches no device at all,
// and legacy admission skipped `requireCommandSupported` for exactly that
// reason. `resolveWaitRuntimePlan` returns a plan with no `use`, so there is
// nothing to inspect and nothing to bind — including on a target whose capture
// fact is unavailable.
// ---------------------------------------------------------------------------

test('a duration wait inspects no facts and binds no device', async () => {
  vi.useFakeTimers();
  try {
    const harness = waitRuntimeHarness({ capture: captureUnavailable });
    const pending = runWait(['5'], harness);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5);
    const { response } = await pending;

    expect(response).toMatchObject({ ok: true, data: { waitedMs: 5 } });
    expect(harness.inspectFacts).not.toHaveBeenCalled();
    expect(harness.bindDevice).not.toHaveBeenCalled();
    expect(harness.captureSnapshot).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test('an observing wait binds through the shared selector entry', async () => {
  const harness = waitRuntimeHarness({ findText: available });

  const bound = await resolveBoundSelectorCapture({
    platformServices: daemonPlatformServicesFixture(),
    command: 'wait',
    session: undefined,
    device: harness.device,
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });

  expect(bound.ok).toBe(true);
  if (!bound.ok) return;
  // Wait reaches the platform through the same owning interface as every other selector
  // command; its preferred reading rides that record rather than a parallel binder.
  expect(bound.operations.capture).toBeTypeOf('function');
  expect(bound.operations.findText).toBeTypeOf('function');
  expect(harness.inspectFacts).toHaveBeenCalledTimes(1);
  expect(harness.bindDevice).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// Every observing shape: one inspection, one bind, one declared operation.
// ---------------------------------------------------------------------------

test('a text wait binds the capture use once and polls through the bound operation', async () => {
  const harness = waitRuntimeHarness();

  const { response } = await runWait(['text', 'Ready'], harness);

  expect(response).toMatchObject({ ok: true, data: { text: 'Ready' } });
  expect(harness.inspectFacts).toHaveBeenCalledTimes(1);
  expect(harness.inspectFacts).toHaveBeenCalledWith(harness.device);
  expect(harness.bindDevice).toHaveBeenCalledTimes(1);
  expect(harness.bindDevice).toHaveBeenCalledWith(harness.device, waitWithoutActiveAppUse);
  expect(harness.captureSnapshot).toHaveBeenCalled();
});

test('a text wait returns a native owner hit without capturing a snapshot', async () => {
  const harness = waitRuntimeHarness({
    findText: available,
    findTextAnswers: (text) => text === 'Ready',
  });

  const { response } = await runWait(['text', 'Ready'], harness);

  expect(response).toMatchObject({ ok: true, data: { text: 'Ready' } });
  expect(harness.findText).toHaveBeenCalledWith(expect.objectContaining({ text: 'Ready' }));
  expect(harness.bindDevice).toHaveBeenCalledWith(harness.device, waitWithoutActiveAppUse);
  expect(harness.captureSnapshot).not.toHaveBeenCalled();
});

test('the native text reading runs in the same runner context as the capture', async () => {
  let nativeReads = 0;
  const harness = waitRuntimeHarness({
    findText: available,
    findTextAnswers: () => nativeReads++ > 0,
    nodesPerPoll: [[{ index: 0, depth: 0, type: 'Button', label: 'Checkout', hittable: true }]],
  });

  const { response } = await runWait(['text', 'Ready', '4000'], harness, [], {
    debug: true,
    iosXctestrunFile: '/tmp/override.xctestrun',
    iosXctestDerivedDataPath: '/tmp/derived',
  });

  expect(response.ok).toBe(true);
  const captureExecution = harness.captureSnapshot.mock.calls[0]?.[0]?.execution;
  const findTextExecution = harness.findText.mock.calls[0]?.[0]?.execution;
  expect(captureExecution).toMatchObject({
    requestId: 'wait-runtime-test',
    iosXctestrunFile: '/tmp/override.xctestrun',
    iosXctestDerivedDataPath: '/tmp/derived',
  });
  expect(findTextExecution).toEqual(captureExecution);
});

test('native text failure cannot hide a canonical capture failure', async () => {
  const harness = waitRuntimeHarness({ findText: available });
  harness.findText.mockRejectedValueOnce(new Error('native observation failed'));
  harness.captureSnapshot.mockRejectedValueOnce(
    new AppError('COMMAND_FAILED', 'canonical capture failed', {
      reason: 'capture_failed',
    }),
  );

  const { response } = await runWait(['text', 'Ready'], harness);

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error).toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'canonical capture failed',
    details: { reason: 'capture_failed' },
  });
  expect(harness.findText).toHaveBeenCalledTimes(1);
  expect(harness.captureSnapshot).toHaveBeenCalledTimes(1);
});

test('a selector wait binds the capture use once and polls through the bound operation', async () => {
  const harness = waitRuntimeHarness();

  const { response } = await runWait(['label=Ready'], harness);

  expect(response).toMatchObject({ ok: true, data: { selector: 'label=Ready' } });
  expect(harness.inspectFacts).toHaveBeenCalledTimes(1);
  expect(harness.bindDevice).toHaveBeenCalledTimes(1);
  expect(harness.bindDevice).toHaveBeenCalledWith(harness.device, waitWithoutActiveAppUse);
});

test('an unavailable conditional native reading preserves the capture-backed wait path', async () => {
  const harness = waitRuntimeHarness({
    nodesPerPoll: [[{ index: 0, depth: 0, type: 'Button', label: 'Ready', hittable: true }]],
  });

  const { response } = await runWait(['text', 'Ready'], harness);

  expect(response).toMatchObject({ ok: true, data: { text: 'Ready' } });
  expect(harness.inspectFacts).toHaveBeenCalledTimes(1);
  expect(harness.bindDevice).toHaveBeenCalledTimes(1);
  expect(harness.findText).not.toHaveBeenCalled();
  expect(harness.captureSnapshot).toHaveBeenCalledTimes(1);
});

test('a @ref wait binds the capture use once and polls through the bound operation', async () => {
  const harness = waitRuntimeHarness();

  const { response } = await runWait(['@e1'], harness, [
    { index: 0, depth: 0, type: 'Button', label: 'Ready', hittable: true },
  ]);

  expect(response).toMatchObject({ ok: true, data: { text: 'Ready' } });
  expect(harness.inspectFacts).toHaveBeenCalledTimes(1);
  expect(harness.bindDevice).toHaveBeenCalledTimes(1);
  expect(harness.bindDevice).toHaveBeenCalledWith(harness.device, waitWithoutActiveAppUse);
});

test('a stable wait binds the capture use once and polls through the bound operation', async () => {
  const harness = waitRuntimeHarness();

  const { response } = await runWait(['stable', '1', '5000'], harness);

  expect(response).toMatchObject({ ok: true, data: { captures: expect.any(Number) } });
  expect(harness.inspectFacts).toHaveBeenCalledTimes(1);
  expect(harness.bindDevice).toHaveBeenCalledTimes(1);
  expect(harness.bindDevice).toHaveBeenCalledWith(harness.device, waitWithoutActiveAppUse);
});

test.each([
  ['scope', { snapshotScope: 'Root' }],
  ['depth', { snapshotDepth: 2 }],
])('strict wait absent refuses --%s before device admission', async (_option, flags) => {
  const harness = waitRuntimeHarness();

  const { response } = await runWait(['absent', 'label="Ready"', '400'], harness, [], flags);

  expect(response).toMatchObject({
    ok: false,
    error: {
      code: 'INVALID_ARGS',
      details: { command: 'wait', predicate: 'absent' },
    },
  });
  if (!response.ok) {
    expect(response.error.details?.rejectedOption).toBe(_option);
  }
  expect(harness.inspectFacts).not.toHaveBeenCalled();
  expect(harness.bindDevice).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Facts are the only support authority: an unavailable exact-owner fact
// refuses BEFORE any binding, and provider ownership never borrows the local
// family runtime.
// ---------------------------------------------------------------------------

test('an unavailable capture fact refuses an observing wait before binding', async () => {
  const harness = waitRuntimeHarness({ capture: captureUnavailable });

  const { response } = await runWait(['text', 'Ready'], harness);

  expect(response).toEqual({
    ok: false,
    error: {
      code: 'UNSUPPORTED_OPERATION',
      message: 'wait is not supported on this device',
      details: { reason: captureUnavailable.reason },
      hint: captureUnavailable.hint,
    },
  });
  expect(harness.inspectFacts).toHaveBeenCalledTimes(1);
  expect(harness.bindDevice).not.toHaveBeenCalled();
  expect(harness.captureSnapshot).not.toHaveBeenCalled();
});

test('a provider owner that cannot capture fails closed instead of borrowing the local runtime', async () => {
  const harness = waitRuntimeHarness({ capture: captureUnavailable, providerOwned: true });

  const { response } = await runWait(['label=Ready'], harness);

  expect(response).toMatchObject({
    ok: false,
    error: { code: 'UNSUPPORTED_OPERATION' },
  });
  expect(harness.bindDevice).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// The timeout-surface decoration is wait's platform execution too. It reuses
// the SAME binding rather than reaching a second capture owner.
// ---------------------------------------------------------------------------

test('a timed-out wait decorates its failure through the same single binding', async () => {
  vi.useFakeTimers();
  try {
    const harness = waitRuntimeHarness({
      nodesPerPoll: [[{ index: 0, depth: 0, type: 'Button', label: 'Checkout', hittable: true }]],
    });

    const pending = runWait(['text', 'Ready', '1'], harness);
    await vi.advanceTimersByTimeAsync(5_000);
    const { response } = await pending;

    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.message).toContain('wait timed out for text: Ready');
    expect(response.error.message).toContain('Current surface: Checkout');
    expect(harness.inspectFacts).toHaveBeenCalledTimes(1);
    expect(harness.bindDevice).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
