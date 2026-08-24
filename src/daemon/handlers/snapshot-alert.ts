import type { AlertRuntimeInput } from '@agent-device/contracts/alert-runtime';
import {
  type AlertAction,
  DEFAULT_ALERT_TIMEOUT_MS as DEFAULT_TIMEOUT_MS,
} from '@agent-device/contracts/alert-contract';
import type { BoundDeviceRuntime } from '@agent-device/contracts/platform-runtime';
import {
  alertAcceptUse,
  alertDismissUse,
  alertReadUse,
  alertWaitUse,
} from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { contextFromFlags } from '../context.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { recordIfSession } from './snapshot-session.ts';
import { parseTimeout } from '../../utils/parse-timeout.ts';
import { resolveRefFrameEffect } from '../daemon-command-registry.ts';
import { expireRefFrame } from '../ref-frame.ts';
import type { DaemonFailureResponse } from './response.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import { admitRuntimeUse, type RuntimeAdmissionBindings } from '../runtime-admission.ts';
import { runtimeExecutionFromContext } from '../snapshot-runtime-capture-input.ts';

type HandleAlertCommandParams = {
  req: DaemonRequest;
  logPath: string;
  sessionStore: SessionStore;
  session: SessionState | undefined;
  device: SessionState['device'];
  inspectFacts?: InspectDeviceRuntimeFacts;
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
  params: Readonly<{ device: DeviceInfo; action: AlertAction }> & RuntimeAdmissionBindings,
): Promise<ResolvedAlertExecution> {
  const { device, action, inspectFacts, bindDevice } = params;
  const shared = { command: 'alert', device, inspectFacts, bindDevice };
  if (action === 'wait') {
    const admission = await admitRuntimeUse({ ...shared, use: alertWaitUse });
    if (admission.type === 'response') return { ok: false, response: admission.response };
    const runtime = admission.runtime;
    return { ok: true, execute: (input) => executeAwaitAlert(runtime, input) };
  }
  if (action === 'accept') {
    const admission = await admitRuntimeUse({ ...shared, use: alertAcceptUse });
    if (admission.type === 'response') return { ok: false, response: admission.response };
    const runtime = admission.runtime;
    return { ok: true, execute: (input) => executeAcceptAlert(runtime, input) };
  }
  if (action === 'dismiss') {
    const admission = await admitRuntimeUse({ ...shared, use: alertDismissUse });
    if (admission.type === 'response') return { ok: false, response: admission.response };
    const runtime = admission.runtime;
    return { ok: true, execute: (input) => executeDismissAlert(runtime, input) };
  }
  const admission = await admitRuntimeUse({ ...shared, use: alertReadUse });
  if (admission.type === 'response') return { ok: false, response: admission.response };
  const runtime = admission.runtime;
  return { ok: true, execute: (input) => executeReadAlert(runtime, input) };
}

async function executeReadAlert(
  runtime: BoundDeviceRuntime<typeof alertReadUse>,
  input: AlertRuntimeInput,
): Promise<Record<string, unknown>> {
  return await runtime.operations.readAlert(input);
}

async function executeAwaitAlert(
  runtime: BoundDeviceRuntime<typeof alertWaitUse>,
  input: AlertRuntimeInput,
): Promise<Record<string, unknown>> {
  return await runtime.operations.awaitAlert(input);
}

async function executeAcceptAlert(
  runtime: BoundDeviceRuntime<typeof alertAcceptUse>,
  input: AlertRuntimeInput,
): Promise<Record<string, unknown>> {
  return await runtime.operations.acceptAlert(input);
}

async function executeDismissAlert(
  runtime: BoundDeviceRuntime<typeof alertDismissUse>,
  input: AlertRuntimeInput,
): Promise<Record<string, unknown>> {
  return await runtime.operations.dismissAlert(input);
}

export async function handleAlertCommand(
  params: HandleAlertCommandParams,
): Promise<DaemonResponse> {
  const { req, logPath, sessionStore, session, device, inspectFacts, bindDevice } = params;
  const action = normalizeAlertAction(req.positionals?.[0]);
  const bound = await resolveBoundAlertRuntime({ device, action, inspectFacts, bindDevice });
  if (!bound.ok) return bound.response;
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
    timeoutMs: parseTimeout(req.positionals?.[1]) ?? DEFAULT_TIMEOUT_MS,
    ...alertTarget(session),
    execution: runtimeExecutionFromContext(context),
  });
  recordIfSession(sessionStore, session, req, data);
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

function normalizeAlertAction(action: string | undefined): AlertAction {
  if (action === 'accept' || action === 'dismiss' || action === 'wait') return action;
  return 'get';
}
