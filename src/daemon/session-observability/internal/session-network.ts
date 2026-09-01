import type { NetworkDumpResult } from '@agent-device/contracts/network-runtime';
import {
  networkAdmissionUse,
  resolveNetworkRuntimePlan,
} from '@agent-device/contracts/network-runtime-plan';
import { NETWORK_INCLUDE_MODES, type NetworkIncludeMode } from '@agent-device/kernel/contracts';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import type { BindDeviceRuntime } from '../../request-runtime-binding.ts';
import type { SessionStore } from '../../session-store.ts';
import type { DaemonRequest, DaemonResponse } from '../../types.ts';
import { errorResponse, type DaemonFailureResponse } from '../../response.ts';

const NETWORK_ACTIONS = ['dump', 'log'] as const;
const NETWORK_ACTIONS_MESSAGE = `network requires ${NETWORK_ACTIONS.join(' or ')}`;
const NETWORK_INCLUDE_MESSAGE = `network include mode must be one of: ${NETWORK_INCLUDE_MODES.join(', ')}`;
const NETWORK_MAX_PAYLOAD_CHARS = 2048;
const NETWORK_MAX_SCAN_LINES = 4000;

export type NetworkHandlerParams = Readonly<{
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  bindDevice?: BindDeviceRuntime;
}>;

type NetworkRequest = Readonly<{
  action: (typeof NETWORK_ACTIONS)[number];
  include: NetworkIncludeMode;
  maxEntries: number;
}>;

export async function handleNetworkCommand(params: NetworkHandlerParams): Promise<DaemonResponse> {
  const session = params.sessionStore.get(params.sessionName);
  if (!session) {
    return errorResponse('SESSION_NOT_FOUND', 'network requires an active session');
  }

  try {
    const bindDevice = requireNetworkBindDevice(params.bindDevice);
    const admission = await bindDevice(session.device, networkAdmissionUse);
    const networkFact = admission.facts.networkDump;
    if (!networkFact.available) return unsupportedNetworkResponse(networkFact.hint);

    const request = resolveNetworkRequest(params.req);
    if (!request.ok) return request;
    const plan = resolveNetworkRuntimePlan({
      action: request.action,
      include: request.include,
    });
    const runtime = await bindDevice(session.device, plan.use);
    const appLog = session.appLog?.handle.inspect();
    const result = await runtime.operations.networkDump({
      sessionId: params.sessionName,
      appBundleId: session.appBundleId,
      ...(appLog ? { appLogSnapshot: { state: appLog.state, startedAt: appLog.startedAt } } : {}),
      maxEntries: request.maxEntries,
      include: plan.include,
      maxPayloadChars: NETWORK_MAX_PAYLOAD_CHARS,
      maxScanLines: NETWORK_MAX_SCAN_LINES,
    });
    return networkDumpResponse(result, request, Boolean(session.appLog), appLog?.state);
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

function requireNetworkBindDevice(bindDevice: BindDeviceRuntime | undefined): BindDeviceRuntime {
  if (bindDevice) return bindDevice;
  throw new AppError('COMMAND_FAILED', 'Device runtime gateway is not configured', {
    reason: 'runtime-gateway-missing',
  });
}

function resolveNetworkRequest(
  req: DaemonRequest,
): (NetworkRequest & Readonly<{ ok: true }>) | DaemonFailureResponse {
  const action = resolveNetworkAction(req);
  if (!action.ok) return action;
  const maxEntries = resolveNetworkLimit(req);
  if (!maxEntries.ok) return maxEntries;
  const include = resolveNetworkIncludeMode(req);
  if (!include.ok) return include;
  return {
    ok: true,
    action: action.action,
    include: include.include,
    maxEntries: maxEntries.maxEntries,
  };
}

function resolveNetworkAction(
  req: DaemonRequest,
): { ok: true; action: (typeof NETWORK_ACTIONS)[number] } | DaemonFailureResponse {
  const action = (req.positionals?.[0] ?? 'dump').toLowerCase();
  if (!NETWORK_ACTIONS.includes(action as (typeof NETWORK_ACTIONS)[number])) {
    return errorResponse('INVALID_ARGS', NETWORK_ACTIONS_MESSAGE);
  }
  return { ok: true, action: action as (typeof NETWORK_ACTIONS)[number] };
}

function resolveNetworkLimit(
  req: DaemonRequest,
): { ok: true; maxEntries: number } | DaemonFailureResponse {
  const maxEntries = req.positionals?.[1] ? Number.parseInt(req.positionals[1], 10) : 25;
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 200) {
    return errorResponse('INVALID_ARGS', 'network dump limit must be an integer in range 1..200');
  }
  return { ok: true, maxEntries };
}

function resolveNetworkIncludeMode(
  req: DaemonRequest,
): { ok: true; include: NetworkIncludeMode } | DaemonFailureResponse {
  const positionalInclude = req.positionals?.[2]?.toLowerCase();
  const flagInclude = req.flags?.networkInclude;
  if (positionalInclude && flagInclude && positionalInclude !== flagInclude) {
    return errorResponse(
      'INVALID_ARGS',
      'network include mode was provided both positionally and via --include with different values',
    );
  }
  const requestedInclude = (flagInclude ?? positionalInclude ?? 'summary').toLowerCase();
  if (!NETWORK_INCLUDE_MODES.includes(requestedInclude as NetworkIncludeMode)) {
    return errorResponse('INVALID_ARGS', NETWORK_INCLUDE_MESSAGE);
  }
  return { ok: true, include: requestedInclude as NetworkIncludeMode };
}

function unsupportedNetworkResponse(hint: string | undefined): DaemonFailureResponse {
  return {
    ok: false,
    error: {
      code: 'UNSUPPORTED_OPERATION',
      message: 'network is not supported on this device',
      hint,
    },
  };
}

function networkDumpResponse(
  result: NetworkDumpResult,
  request: Pick<NetworkRequest, 'include' | 'maxEntries'>,
  active: boolean,
  state: 'active' | 'recovering' | 'ended' | 'failed' | undefined,
): DaemonResponse {
  if (result.source === 'app-log') {
    return {
      ok: true,
      data: {
        ...result.dump,
        active,
        state: state ?? 'inactive',
        backend: result.backend,
        notes: result.notes,
      },
    };
  }

  return {
    ok: true,
    data: {
      entries: result.entries,
      active: true,
      state: 'active',
      backend: result.backend,
      include: request.include,
      matchedLines: result.entries.length,
      scannedLines: result.entries.length,
      limits: {
        maxEntries: request.maxEntries,
        maxPayloadChars: NETWORK_MAX_PAYLOAD_CHARS,
        maxScanLines: result.entries.length,
      },
      notes: result.notes,
    },
  };
}
