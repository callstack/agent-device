import { expect, test, vi } from 'vitest';
import { WAIT_REASONS } from '@agent-device/contracts/interaction';
import {
  localRuntimeOwner,
  narrowDeviceBinding,
  providerRuntimeOwner,
  snapshotRuntimeOperationFacts,
  type CaptureSnapshotInput,
  type DeviceBinding,
  type PlatformRuntimeOperations,
  type RuntimeFacts,
  type RuntimeOperationFact,
  waitSelectorCaptureRuntimePlanUses,
  type FindTextInput,
  type SnapshotResult,
} from '@agent-device/contracts/platform';
import { deviceShape, type DeviceInfo } from '@agent-device/kernel/device';
import { makeSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { unavailableDeploymentSnapshotAndShutdownOperationFacts } from '../../__tests__/test-utils/runtime-operation-facts.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import { handleSnapshotCommands } from '../handlers/snapshot.ts';
import { resolveBoundSelectorCapture } from '../selector-capture-binding.ts';
import type { DaemonRequest } from '../types.ts';

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
 * `core/dispatch.ts`. `captureSnapshot` is the ONE operation `wait` declares, so this harness is
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
  sessionStore.set(session.name, session);
  const response = await handleSnapshotCommands({
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
  const harness = waitRuntimeHarness({ capture: captureUnavailable });

  const { response } = await runWait(['5'], harness);

  expect(response).toMatchObject({ ok: true, data: { waitedMs: 5 } });
  expect(harness.inspectFacts).not.toHaveBeenCalled();
  expect(harness.bindDevice).not.toHaveBeenCalled();
  expect(harness.captureSnapshot).not.toHaveBeenCalled();
});

test('an observing wait binds through the shared selector entry', async () => {
  const harness = waitRuntimeHarness({ findText: available });

  const bound = await resolveBoundSelectorCapture({
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

test('a selector wait binds the capture use once and polls through the bound operation', async () => {
  const harness = waitRuntimeHarness();

  const { response } = await runWait(['label=Ready'], harness);

  expect(response).toMatchObject({ ok: true, data: { selector: 'label=Ready' } });
  expect(harness.inspectFacts).toHaveBeenCalledTimes(1);
  expect(harness.bindDevice).toHaveBeenCalledTimes(1);
  expect(harness.bindDevice).toHaveBeenCalledWith(harness.device, waitWithoutActiveAppUse);
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
  const harness = waitRuntimeHarness({
    nodesPerPoll: [[{ index: 0, depth: 0, type: 'Button', label: 'Checkout', hittable: true }]],
  });

  const { response } = await runWait(['text', 'Ready', '1'], harness);

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.message).toContain('wait timed out for text: Ready');
  expect(response.error.message).toContain('Current surface: Checkout');
  expect(harness.inspectFacts).toHaveBeenCalledTimes(1);
  expect(harness.bindDevice).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// The fact-conditional native observation (ADR 0019 §2). These are the regressions
// for the iOS Smoke failure this unit's first revision caused:
// `wait text "Last input: press"`
// performed 17 readable canonical-tree captures, never observed the target,
// and timed out with `wait_target_absent`. The target is reported by the
// owner's native reading and is absent from the canonical tree, so a
// tree-only poll cannot satisfy it — which is exactly what these assert.
// ---------------------------------------------------------------------------

test('a text wait is satisfied by the owner native reading when the tree never carries it', async () => {
  // The target appears on the owner's native reading from the second poll onward and NEVER
  // appears in the canonical tree, which keeps reporting a different screen — the divergence
  // iOS Smoke hit. The first poll therefore proves the tree cannot satisfy this wait, and the
  // second proves the native reading can.
  let nativeReads = 0;
  const harness = waitRuntimeHarness({
    findText: available,
    findTextAnswers: (text) => {
      nativeReads += 1;
      return text === 'Last input: press' && nativeReads > 1;
    },
    nodesPerPoll: [[{ index: 0, depth: 0, type: 'Button', label: 'Checkout', hittable: true }]],
  });

  const { response } = await runWait(['text', 'Last input: press', '2000'], harness);

  expect(response).toMatchObject({ ok: true, data: { text: 'Last input: press' } });
  expect(harness.findText.mock.calls[0]?.[0]).toMatchObject({ text: 'Last input: press' });
  // Not vacuous in either direction: the tree WAS consulted and could not satisfy the target,
  // so the wait is satisfied only because the native reading answered. Delete the `findText`
  // arm from `observeText` and this times out with `wait_target_absent` after burning the whole
  // budget on readable captures — the exact shape iOS Smoke reported.
  expect(harness.captureSnapshot).toHaveBeenCalled();
});

test('a satisfied native reading short-circuits the poll without capturing', async () => {
  const harness = waitRuntimeHarness({
    findText: available,
    findTextAnswers: () => true,
  });

  const { response } = await runWait(['text', 'Ready', '2000'], harness);

  expect(response).toMatchObject({ ok: true, data: { text: 'Ready' } });
  expect(harness.findText).toHaveBeenCalledTimes(1);
  // The benefit the §9 measurement records: a satisfied wait costs one native query, not a
  // full accessibility capture.
  expect(harness.captureSnapshot).not.toHaveBeenCalled();
});

test('a negative native reading is not an answer — the same poll consults the canonical tree', async () => {
  const harness = waitRuntimeHarness({
    findText: available,
    findTextAnswers: () => false,
    nodesPerPoll: [[{ index: 0, depth: 0, type: 'Button', label: 'Ready', hittable: true }]],
  });

  const { response } = await runWait(['text', 'Ready', '2000'], harness);

  expect(response).toMatchObject({ ok: true, data: { text: 'Ready' } });
  expect(harness.findText).toHaveBeenCalled();
  // A negative native observation never replaces the capture-backed half of the same poll.
  expect(harness.captureSnapshot).toHaveBeenCalled();
});

test('an owner that advertises no native reading polls the tree only', async () => {
  const harness = waitRuntimeHarness({
    nodesPerPoll: [[{ index: 0, depth: 0, type: 'Button', label: 'Ready', hittable: true }]],
  });

  const { response } = await runWait(['text', 'Ready', '2000'], harness);

  expect(response).toMatchObject({ ok: true, data: { text: 'Ready' } });
  expect(harness.findText).not.toHaveBeenCalled();
  expect(harness.captureSnapshot).toHaveBeenCalled();
  expect(harness.bindDevice).toHaveBeenCalledTimes(1);
});

test('an unavailable conditional observation preserves the capture-backed owner path', async () => {
  const harness = waitRuntimeHarness({
    findText: findTextUnavailable,
    nodesPerPoll: [[{ index: 0, depth: 0, type: 'Button', label: 'Ready', hittable: true }]],
  });

  const { response } = await runWait(['text', 'Ready', '2000'], harness);

  expect(response.ok).toBe(true);
  expect(harness.inspectFacts).toHaveBeenCalledTimes(1);
  expect(harness.bindDevice).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// The conditional reading and the capture it short-circuits must run in the SAME
// runner context. Asserted as an equality against capture's own context rather
// than field by field, so the check cannot rot into a partial one when a new
// execution field is added: whatever capture carries, findText must carry too.
// ---------------------------------------------------------------------------

test('the native text reading runs in the same runner context as the capture', async () => {
  let nativeReads = 0;
  const harness = waitRuntimeHarness({
    findText: available,
    // Miss on the first poll so BOTH legs run and their contexts can be compared.
    findTextAnswers: () => {
      nativeReads += 1;
      return nativeReads > 1;
    },
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
  // Non-trivially populated: a comparison of two undefineds would prove nothing.
  expect(captureExecution).toMatchObject({
    requestId: 'wait-runtime-test',
    iosXctestrunFile: '/tmp/override.xctestrun',
    iosXctestDerivedDataPath: '/tmp/derived',
  });
  expect(findTextExecution).toEqual(captureExecution);
});

// ---------------------------------------------------------------------------
// Per-poll cancellation, end to end (`CaptureSnapshotInput.signal`).
//
// A binding's signal is fixed at bind time and `wait` binds once and polls many
// times, so each poll enforces its own remaining budget by ABORTING that
// capture and then waiting for it to quiesce. Without the per-capture signal
// the deadline never reaches the platform: a stalled capture consumes the whole
// request and `WAIT_REASONS.captureStalled` becomes unreachable.
// ---------------------------------------------------------------------------

/** A capture that never settles on its own — it resolves only once its poll deadline aborts it. */
function stallingCapture() {
  const seen: AbortSignal[] = [];
  const settledAt: number[] = [];
  const captureSnapshot = vi.fn(async (input: CaptureSnapshotInput) => {
    const signal = input.signal;
    if (!signal) throw new Error('the poll deadline never reached the platform');
    seen.push(signal);
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    // A late capture: it settles only after its deadline fired.
    settledAt.push(Date.now());
    throw new DOMException('Capture aborted', 'AbortError');
  });
  return { captureSnapshot, seen, settledAt };
}

test('a poll deadline aborts the in-flight capture, and aborts it as a deadline', async () => {
  const stalling = stallingCapture();
  const harness = waitRuntimeHarness({ captureSnapshot: stalling.captureSnapshot });

  await runWait(['text', 'Ready', '150'], harness);

  expect(stalling.seen.length).toBeGreaterThan(0);
  const signal = stalling.seen[0]!;
  expect(signal.aborted).toBe(true);
  // Not merely "aborted": a request-end abort would also satisfy that. The deadline controller
  // aborts with its own TimeoutError, which is what proves the POLL budget did the cancelling.
  expect((signal.reason as DOMException | undefined)?.name).toBe('TimeoutError');
});

test('the poll awaits the aborted capture instead of abandoning it', async () => {
  const stalling = stallingCapture();
  const harness = waitRuntimeHarness({ captureSnapshot: stalling.captureSnapshot });

  await runWait(['text', 'Ready', '150'], harness);
  const returnedAt = Date.now();

  // Ordering is the property, not the abort. `runWithinWaitDeadline` deliberately does not
  // race-and-abandon: a late capture must not be able to write session state after the wait
  // has already returned.
  expect(stalling.settledAt.length).toBeGreaterThan(0);
  for (const settled of stalling.settledAt) expect(settled).toBeLessThanOrEqual(returnedAt);
});

test('a stalled capture reports capture-stalled with no readable captures', async () => {
  const stalling = stallingCapture();
  const harness = waitRuntimeHarness({ captureSnapshot: stalling.captureSnapshot });

  const { response } = await runWait(['text', 'Ready', '150'], harness);

  expect(response.ok).toBe(false);
  if (response.ok) return;
  // Distinct from `wait_target_absent` (readable captures that lacked the target) and from
  // `wait_deadline_exceeded` (a poll truncated after readable captures). Three separate paths in
  // `waitTimeoutError`; collapsing any pair loses real diagnostic information.
  expect(response.error.details?.reason).toBe(WAIT_REASONS.captureStalled);
  expect(response.error.details?.captureStalled).toBe(true);
  expect(response.error.details?.readableCaptures).toBe(0);
});

test('a readable capture that lacks the target stays target-absent, not capture-stalled', async () => {
  const harness = waitRuntimeHarness({
    nodesPerPoll: [[{ index: 0, depth: 0, type: 'Button', label: 'Checkout', hittable: true }]],
  });

  const { response } = await runWait(['text', 'Ready', '400'], harness);

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.details?.reason).toBe(WAIT_REASONS.targetAbsent);
  expect(response.error.details?.readableCaptures).toBeGreaterThan(0);
});
