import {
  resolveSnapshotRuntimePlan,
  type CaptureSnapshotInput,
  type ElementTextRuntimeOperations,
  type ReadTextAtPointInput,
  type RuntimeOperationFact,
  type SelectorCaptureRuntimePlan,
  type SnapshotResult,
  type SnapshotRuntimeOperations,
  type SnapshotRuntimePlan,
} from '@agent-device/contracts/platform';
import { buildIosOpenCommandHint } from './ios-app-session-hint.ts';
import { buildRuntimeCaptureInput } from './snapshot-runtime-capture-input.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from './request-runtime-binding.ts';
import { SessionStore } from './session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from './types.ts';
import {
  admitRuntimePlan,
  requireRuntimeBinding,
  unavailableRuntimeOperationResponse,
  unwrapAdmittedRuntimePlan,
  type AdmittedRuntimePlan,
} from './handlers/session-runtime-admission.ts';
import { errorResponse } from './handlers/response.ts';
import { resolveSnapshotScope } from './handlers/snapshot-capture.ts';
import { resolveSessionDevice } from './handlers/snapshot-session.ts';

export type SnapshotRuntimeRouteParams = {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
};

type ResolvedSnapshotCaptureRuntime =
  | Readonly<{
      ok: true;
      session: SessionState | undefined;
      device: SessionState['device'];
      snapshotScope: string | undefined;
      captureSnapshot: () => Promise<SnapshotResult>;
    }>
  | Readonly<{ ok: false; response: DaemonResponse }>;

/** A capture operation parametrized by intent, so a polling caller can capture repeatedly
 * under the one binding it was admitted for. */
export type BoundSnapshotCapture = (input: CaptureSnapshotInput) => Promise<SnapshotResult>;

/** The owner's live element read, when its facts advertise one. */
export type BoundElementRead = ElementTextRuntimeOperations['readTextAtPoint'];

export type AdmittedSnapshotCapture =
  | Readonly<{
      ok: true;
      capture: BoundSnapshotCapture;
      /**
       * The owner's live element read, present only when the caller's plan declared it PREFERRED
       * and the admitted owner advertised it. `snapshot`/`diff` plans declare no read, so this is
       * simply absent for them — the member is additive and they are unchanged.
       */
      readTextAtPoint?: BoundElementRead;
    }>
  | Readonly<{ ok: false; response: DaemonResponse }>;

/**
 * The ONE admit-then-bind path for every request-bound snapshot capture (ADR 0019 §9):
 * side-effect-free facts inspection, refusal before any binding, then exactly one bind on
 * the admitted device. `snapshot`/`diff` supply the four-way custom-actions plan and the
 * selector family the active-app plan; a new consumer supplies a plan and a command name.
 */
export async function admitAndBindSnapshotCapture(
  params: Readonly<{
    command: string;
    device: SessionState['device'];
    session: SessionState | undefined;
    plan: SnapshotRuntimePlan | SelectorCaptureRuntimePlan;
    inspectFacts?: InspectDeviceRuntimeFacts;
    bindDevice?: BindDeviceRuntime;
  }>,
): Promise<AdmittedSnapshotCapture> {
  const { command, device, session, plan } = params;
  const admission = await admitRuntimePlan({ device, plan, inspectFacts: params.inspectFacts });
  if (!admission.admitted) {
    return {
      ok: false,
      response: await snapshotPlanUnavailableResponse({
        operation: admission.operation,
        fact: admission.fact,
        session,
        device,
        command,
      }),
    };
  }
  const bound = await bindSnapshotCaptureRuntime(params.bindDevice, admission);
  return Object.freeze({
    ok: true,
    capture: async (input: CaptureSnapshotInput) => await bound.captureSnapshot(input),
    ...(bound.readTextAtPoint ? { readTextAtPoint: bound.readTextAtPoint } : {}),
  });
}

/** Resolves one plan, inspects its owner facts once, then returns one bound capture closure. */
export async function resolveBoundSnapshotCaptureRuntime(
  params: SnapshotRuntimeRouteParams,
  command: 'snapshot' | 'diff',
): Promise<ResolvedSnapshotCaptureRuntime> {
  const { req, sessionName, sessionStore } = params;
  const { session, device } = await resolveSessionDevice(sessionStore, sessionName, req.flags);
  const resolvedScope = resolveSnapshotScope(req.flags?.snapshotScope, session);
  if (!resolvedScope.ok) return { ok: false, response: resolvedScope };

  const bound = await admitAndBindSnapshotCapture({
    command,
    device,
    session,
    plan: resolveSnapshotRuntimePlan({
      customActions: req.flags?.snapshotCustomActions === true,
      hasActiveApp: session?.appBundleId !== undefined,
    }),
    inspectFacts: params.inspectFacts,
    bindDevice: params.bindDevice,
  });
  if (!bound.ok) return bound;

  const captureInput = buildRuntimeCaptureInput({
    flags: req.flags,
    logPath: params.logPath,
    meta: req.meta,
    session,
    snapshotScope: resolvedScope.scope,
  });
  return Object.freeze({
    ok: true,
    session,
    device,
    snapshotScope: resolvedScope.scope,
    captureSnapshot: async () => await bound.capture(captureInput),
  });
}

/**
 * Binds only an admitted plan, on the device it was admitted for: the token is minted by
 * `admitRuntimePlan` alone and unwrapped by exact identity, so nothing that was not admitted —
 * a bare plan, a separate device, a look-alike or Proxy — can reach the capture operations.
 */
async function bindSnapshotCaptureRuntime(
  bindDevice: BindDeviceRuntime | undefined,
  admission: AdmittedRuntimePlan<SnapshotRuntimePlan | SelectorCaptureRuntimePlan>,
): Promise<
  Readonly<{
    captureSnapshot(input: CaptureSnapshotInput): Promise<SnapshotResult>;
    readTextAtPoint?: BoundElementRead;
  }>
> {
  const bind = requireRuntimeBinding(bindDevice);
  const { device, plan } = unwrapAdmittedRuntimePlan(admission);
  // One switch, one set of operation selectors. The selector arms reuse the SAME
  // `selectActiveAppSnapshot` / `selectSnapshotWithoutActiveApp` the snapshot arms use and only
  // add the preferred element read; the discriminants differ solely so the compiler can narrow
  // `plan.use` per family. No parallel plan-to-operation dispatch is introduced.
  switch (plan.kind) {
    case 'active-app': {
      const runtime = await bind(device, plan.use);
      return selectActiveAppSnapshot(runtime);
    }
    case 'selector-active-app': {
      const runtime = await bind(device, plan.use);
      return { ...selectActiveAppSnapshot(runtime), ...selectElementRead(runtime) };
    }
    case 'custom-actions-active-app': {
      const runtime = await bind(device, plan.use);
      return selectCustomActionsSnapshot(runtime);
    }
    case 'without-active-app': {
      const runtime = await bind(device, plan.use);
      return selectSnapshotWithoutActiveApp(runtime);
    }
    case 'selector-without-active-app': {
      const runtime = await bind(device, plan.use);
      return { ...selectSnapshotWithoutActiveApp(runtime), ...selectElementRead(runtime) };
    }
    case 'custom-actions-without-active-app': {
      const runtime = await bind(device, plan.use);
      return selectCustomActionsSnapshot(runtime);
    }
  }
}

/**
 * Projects the preferred element read when the admitted owner advertised it. A projection whose
 * use never declared it simply has no such member, so this yields `{}` for `snapshot`/`diff`.
 */
function selectElementRead(
  runtime: Readonly<{ operations: Readonly<{ readTextAtPoint?: BoundElementRead }> }>,
): Readonly<{ readTextAtPoint?: BoundElementRead }> {
  const readTextAtPoint = runtime.operations.readTextAtPoint;
  // Narrowed by CONSTRUCTION rather than by assertion: the projection below is only buildable
  // from a non-undefined local, so presence is carried by the value that captured it.
  return readTextAtPoint
    ? { readTextAtPoint: bindElementRead({ operations: { readTextAtPoint } }) }
    : {};
}

/** The one lexical owner of the narrowed `readTextAtPoint` call. */
function bindElementRead(
  runtime: Readonly<{ operations: Readonly<{ readTextAtPoint: BoundElementRead }> }>,
): BoundElementRead {
  return async (input: ReadTextAtPointInput) => await runtime.operations.readTextAtPoint(input);
}

type BoundSnapshotOperation<Operation extends keyof SnapshotRuntimeOperations> = Readonly<{
  operations: Readonly<Pick<SnapshotRuntimeOperations, Operation>>;
}>;

function selectActiveAppSnapshot(runtime: BoundSnapshotOperation<'captureSnapshot'>) {
  return Object.freeze({
    captureSnapshot: async (input: CaptureSnapshotInput) =>
      await runtime.operations.captureSnapshot(input),
  });
}

function selectCustomActionsSnapshot(
  runtime: BoundSnapshotOperation<'captureSnapshotWithCustomActions'>,
) {
  return Object.freeze({
    captureSnapshot: async (input: CaptureSnapshotInput) =>
      await runtime.operations.captureSnapshotWithCustomActions(input),
  });
}

function selectSnapshotWithoutActiveApp(
  runtime: BoundSnapshotOperation<'captureSnapshotWithoutActiveApp'>,
) {
  return Object.freeze({
    captureSnapshot: async (input: CaptureSnapshotInput) =>
      await runtime.operations.captureSnapshotWithoutActiveApp(input),
  });
}

type SnapshotPlanUnavailableParams = {
  operation: SnapshotRuntimePlan['use']['required'][number];
  fact: RuntimeOperationFact;
  session: SessionState | undefined;
  device: SessionState['device'];
  command: string;
};

async function snapshotPlanUnavailableResponse(
  params: SnapshotPlanUnavailableParams,
): Promise<DaemonResponse> {
  if (params.operation === 'captureSnapshot') {
    return unavailableRuntimeOperationResponse(params.command, params.fact)!;
  }
  if (params.operation === 'captureSnapshotWithCustomActions') {
    return snapshotCustomActionsUnavailableResponse(params);
  }
  const openCommandHint = await buildIosOpenCommandHint(params.device);
  return errorResponse(
    'SESSION_NOT_FOUND',
    `iOS ${params.command} requires an active app session on the target device. Run open first (for example: open --session ${params.session?.name ?? 'sim'} --platform ios --device "<name>" <app>).`,
    {
      reason: 'ios_app_session_required',
      ...(openCommandHint ? { hint: openCommandHint } : {}),
    },
  );
}

function snapshotCustomActionsUnavailableResponse(
  params: SnapshotPlanUnavailableParams,
): DaemonResponse {
  const unavailableMessage =
    params.command === 'diff'
      ? `--actions requires an iOS simulator: custom actions are read through the private accessibility snapshot backend, which ${params.device.platform}/${params.device.kind} targets do not have.`
      : `--actions requires an iOS simulator: custom actions are unavailable on this ${params.device.platform}/${params.device.kind} target.`;
  return errorResponse(
    'UNSUPPORTED_OPERATION',
    unavailableMessage,
    { reason: params.fact.available ? undefined : params.fact.reason },
    {
      hint:
        params.command === 'diff' || params.fact.available || !params.fact.hint
          ? 'Re-run without --actions, or target an iOS simulator.'
          : params.fact.hint,
    },
  );
}
