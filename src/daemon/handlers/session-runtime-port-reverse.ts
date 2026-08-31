import type { ProviderPortReverseOptions } from '@agent-device/contracts/device';
import { configureProviderPortReverseRuntimeUse } from '@agent-device/contracts/application-lifecycle-runtime-plan';
import type { DaemonRequest, DaemonResponse } from '../types.ts';
import type { SessionStore } from '../session-store.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import { admitRuntimeUse } from '../runtime-admission.ts';
import { errorResponse } from '../response.ts';
import {
  requireSessionOrExplicitSelector,
  resolveCommandDevice,
} from '../session-device-resolution.ts';

type PortReverseParseResult =
  | { ok: true; options: ProviderPortReverseOptions }
  | { ok: false; response: DaemonResponse };
type PortReverseRequiredFields =
  | { ok: true; leaseId: string; provider: string }
  | { ok: false; response: DaemonResponse };
type PortReversePorts =
  | { ok: true; devicePort: number; hostPort: number }
  | { ok: false; response: DaemonResponse };

export async function handlePortReverseCommand(params: {
  req: DaemonRequest;
  session: ReturnType<SessionStore['get']>;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
}): Promise<DaemonResponse> {
  const { req, session, inspectFacts, bindDevice } = params;
  const parsed = readPortReverseOptions(req);
  if (!parsed.ok) return parsed.response;
  const selectorError = requireSessionOrExplicitSelector(
    'runtime port-reverse',
    session,
    req.flags,
  );
  if (selectorError) return selectorError;
  const device = await resolveCommandDevice({
    session,
    flags: req.flags,
    ensureReady: false,
  });
  const admission = await admitRuntimeUse({
    device,
    inspectFacts,
    bindDevice,
    command: 'runtime port-reverse',
    use: configureProviderPortReverseRuntimeUse,
  });
  if (admission.type === 'response') return admission.response;
  if (
    admission.runtime.owner.kind !== 'provider-runtime' ||
    admission.runtime.owner.provider !== parsed.options.provider
  ) {
    return errorResponse(
      'UNSUPPORTED_OPERATION',
      'The selected device is not owned by the requested port-reverse provider.',
      { provider: parsed.options.provider },
    );
  }
  const result = await admission.runtime.operations.configureProviderPortReverse(parsed.options);
  if (!result) {
    return errorResponse(
      'UNSUPPORTED_OPERATION',
      'The selected provider device runtime does not support port reverse for this lease.',
    );
  }
  return { ok: true, data: { action: 'port-reverse', ...result } };
}

function readPortReverseOptions(req: DaemonRequest): PortReverseParseResult {
  const required = readRequiredPortReverseFields(req);
  if (!required.ok) return required;
  const ports = readPortReversePorts(req);
  if (!ports.ok) return ports;
  return {
    ok: true,
    options: {
      leaseId: required.leaseId,
      provider: required.provider,
      devicePort: ports.devicePort,
      hostPort: ports.hostPort,
      name: req.flags?.portReverseName?.trim() || 'runtime',
    },
  };
}

function readRequiredPortReverseFields(req: DaemonRequest): PortReverseRequiredFields {
  const leaseId = req.flags?.leaseId;
  const provider = req.flags?.leaseProvider;
  if (!leaseId) {
    return {
      ok: false,
      response: errorResponse(
        'INVALID_ARGS',
        'runtime port-reverse requires a resolved remote lease.',
      ),
    };
  }
  if (!provider) {
    return {
      ok: false,
      response: errorResponse('INVALID_ARGS', 'runtime port-reverse requires a lease provider.'),
    };
  }
  return { ok: true, leaseId, provider };
}

function readPortReversePorts(req: DaemonRequest): PortReversePorts {
  const devicePort = readTcpPort(req.flags?.devicePort);
  const hostPort = readTcpPort(req.flags?.hostPort ?? req.flags?.devicePort);
  if (!devicePort || !hostPort) {
    return {
      ok: false,
      response: errorResponse(
        'INVALID_ARGS',
        'runtime port-reverse requires numeric devicePort and hostPort values from 1 to 65535.',
      ),
    };
  }
  return { ok: true, devicePort, hostPort };
}

function readTcpPort(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) {
    return undefined;
  }
  return value;
}
