import type {
  BoundDeviceRuntime,
  PlatformRuntimeOperations,
  RuntimeOperationKey,
  RuntimeOperationUnavailability,
  RuntimeUse,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from './request-runtime-binding.ts';
import { errorResponse, type DaemonFailureResponse } from './handlers/response.ts';

/** Builds the failure a command reports when its exact device cell does not admit an operation. */
export type UnavailableRuntimeResponse = (
  unavailable: RuntimeOperationUnavailability,
) => DaemonFailureResponse;

export type AdmittedRuntimeGateway =
  | Readonly<{ type: 'response'; response: DaemonFailureResponse }>
  | Readonly<{ type: 'admitted'; bind: BindDeviceRuntime }>;

export type RuntimeAdmission<Use> =
  | Readonly<{ type: 'response'; response: DaemonFailureResponse }>
  | Readonly<{ type: 'runtime'; runtime: BoundDeviceRuntime<Use> }>;

type RuntimeAdmissionRequest = Readonly<{
  /** Command wording for the default unsupported message, e.g. `open`, `runtime port-reverse`. */
  command: string;
  device: DeviceInfo;
  required: readonly RuntimeOperationKey<PlatformRuntimeOperations>[];
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
  unavailableResponse?: UnavailableRuntimeResponse;
}>;

export type RuntimeAdmissionBindings = Pick<RuntimeAdmissionRequest, 'inspectFacts' | 'bindDevice'>;

/**
 * The one facts-admission seam every migrated command route shares. It performs exactly one
 * side-effect-free inspection and hands back the binding gateway only once the exact device cell
 * admits every operation the caller's plan will invoke, so no route can dispatch first and
 * discover a missing sibling operation afterwards.
 */
export async function admitRuntimeOperations(
  request: RuntimeAdmissionRequest,
): Promise<AdmittedRuntimeGateway> {
  const facts = await requireFactsInspection(request.inspectFacts)(request.device);
  for (const operation of request.required) {
    const fact = facts.operations[operation];
    if (fact.available) continue;
    const response = request.unavailableResponse
      ? request.unavailableResponse(fact)
      : errorResponse(
          'UNSUPPORTED_OPERATION',
          `${request.command} is not supported on this device`,
          undefined,
          fact.hint ? { hint: fact.hint } : undefined,
        );
    return { type: 'response', response };
  }
  return { type: 'admitted', bind: requireDeviceBinding(request.bindDevice) };
}

/**
 * Facts admission plus binding for a route whose plan resolves to a single use. Routes that pick
 * one of several exactly-typed uses admit with {@link admitRuntimeOperations} and bind their
 * selected use themselves.
 */
export async function admitRuntimeUse<
  const Required extends readonly RuntimeOperationKey<PlatformRuntimeOperations>[],
  const Preferred extends readonly Exclude<
    RuntimeOperationKey<PlatformRuntimeOperations>,
    Required[number]
  >[],
>(
  request: Omit<RuntimeAdmissionRequest, 'required'> &
    Readonly<{ use: RuntimeUse<PlatformRuntimeOperations, Required, Preferred> }>,
): Promise<RuntimeAdmission<RuntimeUse<PlatformRuntimeOperations, Required, Preferred>>> {
  const admitted = await admitRuntimeOperations({ ...request, required: request.use.required });
  if (admitted.type === 'response') return admitted;
  return { type: 'runtime', runtime: await admitted.bind(request.device, request.use) };
}

function requireFactsInspection(
  inspectFacts: InspectDeviceRuntimeFacts | undefined,
): InspectDeviceRuntimeFacts {
  if (inspectFacts) return inspectFacts;
  throw new AppError('COMMAND_FAILED', 'Device runtime facts inspection is unavailable.', {
    reason: 'runtime-gateway-missing',
  });
}

function requireDeviceBinding(bindDevice: BindDeviceRuntime | undefined): BindDeviceRuntime {
  if (bindDevice) return bindDevice;
  throw new AppError('COMMAND_FAILED', 'Device runtime binding is unavailable.', {
    reason: 'runtime-gateway-missing',
  });
}
