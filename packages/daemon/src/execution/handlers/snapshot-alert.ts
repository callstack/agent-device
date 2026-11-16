import type { DaemonPlatformServices } from '../../core/platform-services.ts';
import type { AlertRuntimeInput } from '@agent-device/contracts/alert-runtime';
import {
  ALERT_ACTIONS,
  parseAlertAction,
  type AlertAction,
  DEFAULT_ALERT_TIMEOUT_MS as DEFAULT_TIMEOUT_MS,
  ALERT_WAIT_WINDOW_TOO_LONG_REASON,
} from '@agent-device/contracts/alert-contract';
import { AppError } from '@agent-device/kernel/errors';
import {
  alertAcceptUse,
  alertDismissUse,
  alertReadUse,
  alertWaitUse,
} from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { contextFromFlags } from '../../core/context.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import type { SessionRef, SessionState } from '../../core/session-state.ts';
import { SessionStore } from '../../core/session-store.ts';
import { recordSessionAction } from '../../core/session-action-recorder.ts';
import { parseTimeout } from '@agent-device/command-registry/parse-timeout';
import { MAX_ARMABLE_ALERT_WAIT_WINDOW_MS } from '@agent-device/command-registry/timeout-policy';
import { resolveRefFrameEffect } from '../../core/daemon-command-registry.ts';
import { expireRefFrame } from '../../core/ref-frame.ts';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../core/request-runtime-binding.ts';
import { admitRuntimeUse, type RuntimeAdmissionBindings } from '../../core/runtime-admission.ts';
import { runtimeExecutionFromContext } from '../../core/snapshot-runtime-capture-input.ts';
import type { DaemonFailureResponse, DaemonResponse } from '@agent-device/kernel/contracts';

type HandleAlertCommandParams = {
  req: DaemonRequest;
  logPath: string;
  sessionStore: SessionStore;
  ref: SessionRef | undefined;
  device: SessionState['device'];
  inspectFacts?: InspectDeviceRuntimeFacts;
  platformServices: DaemonPlatformServices;
  bindDevice?: BindDeviceRuntime;
};

type ResolvedAlertExecution =
  | Readonly<{ ok: false; response: DaemonFailureResponse }>
  | Readonly<{ ok: true; execute: (input: AlertRuntimeInput) => Promise<Record<string, unknown>> }>;

/**
 * The ONE place `alert` reaches a device (R59). Exactly one action-selected use is admitted and
 * bound per request — the leg the parsed subcommand names, never all four. Each branch admits its
 * own literal use, so the bound runtime narrows from that instantiation rather than an assertion.
 *
 * Every branch names the bare command in its refusal: the retired
 * `requireCommandSupported('alert', device)` gate refused per command, not per subcommand, and
 * that wording is parity-pinned.
 */
async function resolveBoundAlertRuntime(
  params: Readonly<{
    device: DeviceInfo;
    action: AlertAction;
    session: SessionState | undefined;
  }> &
    RuntimeAdmissionBindings,
): Promise<ResolvedAlertExecution> {
  const { device, action, inspectFacts, bindDevice, platformServices } = params;
  const shared = {
    command: 'alert',
    device,
    inspectFacts,
    bindDevice,
    platformServices,
    readiness: !params.session,
  };
  if (action === 'wait') {
    const admission = await admitRuntimeUse({ ...shared, use: alertWaitUse });
    if (admission.type === 'response') return { ok: false, response: admission.response };
    return { ok: true, execute: (input) => admission.runtime.operations.awaitAlert(input) };
  }
  if (action === 'accept') {
    const admission = await admitRuntimeUse({ ...shared, use: alertAcceptUse });
    if (admission.type === 'response') return { ok: false, response: admission.response };
    return { ok: true, execute: (input) => admission.runtime.operations.acceptAlert(input) };
  }
  if (action === 'dismiss') {
    const admission = await admitRuntimeUse({ ...shared, use: alertDismissUse });
    if (admission.type === 'response') return { ok: false, response: admission.response };
    return { ok: true, execute: (input) => admission.runtime.operations.dismissAlert(input) };
  }
  const admission = await admitRuntimeUse({ ...shared, use: alertReadUse });
  if (admission.type === 'response') return { ok: false, response: admission.response };
  return { ok: true, execute: (input) => admission.runtime.operations.readAlert(input) };
}

export async function handleAlertCommand(
  params: HandleAlertCommandParams,
): Promise<DaemonResponse> {
  const { req, logPath, sessionStore, ref, device, inspectFacts, bindDevice, platformServices } =
    params;
  let session = ref ? sessionStore.requireCurrent(ref) : undefined;
  const action = readAlertAction(req.positionals?.[0]);
  const timeoutMs = alertTimeoutMs(action, req.positionals?.[1]);
  const bound = await resolveBoundAlertRuntime({
    device,
    action,
    session,
    inspectFacts,
    bindDevice,
    platformServices,
  });
  if (!bound.ok) return bound.response;
  session = ref ? sessionStore.requireCurrent(ref) : undefined;
  // ADR 0014 side-effect seam: alert accept/dismiss act on the device; get/wait are read-only.
  // The alert resolver returns `may-invalidate` only for the acting subactions, so this covers
  // the accept/dismiss mutations on every owner without touching the read paths.
  if (session && resolveRefFrameEffect(req) === 'may-invalidate') {
    expireRefFrame(session);
  }
  const context = contextFromFlags(
    logPath,
    req.flags,
    session?.appBundleId,
    session?.trace?.outPath,
  );
  const data = await bound.execute({
    timeoutMs,
    ...alertTarget(session),
    execution: runtimeExecutionFromContext(context),
  });
  recordSessionAction(sessionStore, ref, req, req.command, data);
  return { ok: true, data };
}

/**
 * The session's own alert target, forwarded as the session holds it. The two fields stay separate
 * because a macOS frontmost-app surface means "whatever is frontmost" and must reach its helper
 * with no bundle at all — but that narrowing belongs to the Apple owner, which is the only leg
 * that ever applied it. The retired route passed `session?.appBundleId` to the XCTest runner
 * unconditionally, and it still does.
 */
function alertTarget(
  session: SessionState | undefined,
): Readonly<{ appBundleId?: string; surface?: SessionState['surface'] }> {
  return {
    ...(session?.appBundleId === undefined ? {} : { appBundleId: session.appBundleId }),
    ...(session?.surface === undefined ? {} : { surface: session.surface }),
  };
}

/**
 * `get` when absent; an unknown subaction is refused, so the handler never reads where the
 * registry classified a mutation.
 */
function readAlertAction(raw: string | undefined): AlertAction {
  const known = parseAlertAction(raw ?? 'get');
  if (!known) {
    throw new AppError(
      'INVALID_ARGS',
      `alert requires a subcommand: ${ALERT_ACTIONS.join(', ')} (got "${raw}")`,
    );
  }
  return known;
}

/**
 * The `alert` timeout before it reaches any leg: the window `alert wait` polls in, and the budget
 * one `alert get` read spends. Past the window the request envelope can be armed for, a wait cannot
 * be armed as a timer at all, so the command refuses the argument instead of starting a wait that
 * would misfire or be cut off mid-window; the driver's own default remains the last line for
 * budgets that arrive by other routes.
 */
function alertTimeoutMs(action: AlertAction, rawTimeout: string | undefined): number {
  const timeoutMs = parseTimeout(rawTimeout) ?? DEFAULT_TIMEOUT_MS;
  if (action === 'wait' && timeoutMs > MAX_ARMABLE_ALERT_WAIT_WINDOW_MS) {
    throw new AppError(
      'INVALID_ARGS',
      `alert wait timeoutMs exceeds the maximum of ${MAX_ARMABLE_ALERT_WAIT_WINDOW_MS} ms`,
      {
        hint: 'Pass a shorter timeout, or run repeated alert waits.',
        reason: ALERT_WAIT_WINDOW_TOO_LONG_REASON,
        maxWaitWindowMs: MAX_ARMABLE_ALERT_WAIT_WINDOW_MS,
      },
    );
  }
  return timeoutMs;
}
