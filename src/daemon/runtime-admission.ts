import type {
  BoundDeviceRuntime,
  RuntimeOperationKey,
  RuntimeOperationUnavailability,
  RuntimeUse,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
  RuntimeAdmissionBindings,
} from './request-runtime-binding.ts';
import { errorResponse, type DaemonFailureResponse } from './response.ts';
import type { DaemonCommandContext } from './context.ts';
import type { ResolvedGenericExecution } from './request-generic-dispatch.ts';

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

export type RuntimeAdmissionRequest = RuntimeAdmissionBindings &
  Readonly<{
    /** Command wording for the default unsupported message, e.g. `open`, `runtime port-reverse`. */
    command: string;
    device: DeviceInfo;
    required: readonly RuntimeOperationKey<PlatformRuntimeOperations>[];
    unavailableResponse?: UnavailableRuntimeResponse;
  }>;

export type { RuntimeAdmissionBindings };

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
  const Conditional extends readonly Exclude<
    RuntimeOperationKey<PlatformRuntimeOperations>,
    Required[number] | Preferred[number]
  >[],
>(
  request: Omit<RuntimeAdmissionRequest, 'required'> &
    Readonly<{
      use: RuntimeUse<PlatformRuntimeOperations, Required, Preferred, Conditional>;
    }>,
): Promise<
  RuntimeAdmission<RuntimeUse<PlatformRuntimeOperations, Required, Preferred, Conditional>>
> {
  const admitted = await admitRuntimeOperations({ ...request, required: request.use.required });
  if (admitted.type === 'response') return admitted;
  return { type: 'runtime', runtime: await admitted.bind(request.device, request.use) };
}

/**
 * The generic-route admit-then-bind shape every single-use leaf shares (focus, back, home,
 * orientation, tv-remote): admit the exact owner's fact, narrow the binding, and defer execution
 * to a closure the dispatcher invokes with its resolved context. One shared shape here is what
 * keeps five near-identical leaves from drifting into five copies of the same wiring.
 */
export async function resolveBoundGenericRuntime<
  const Required extends readonly RuntimeOperationKey<PlatformRuntimeOperations>[],
  const Preferred extends readonly Exclude<
    RuntimeOperationKey<PlatformRuntimeOperations>,
    Required[number]
  >[],
  const Conditional extends readonly Exclude<
    RuntimeOperationKey<PlatformRuntimeOperations>,
    Required[number] | Preferred[number]
  >[],
>(
  request: Omit<RuntimeAdmissionRequest, 'required'> &
    Readonly<{ use: RuntimeUse<PlatformRuntimeOperations, Required, Preferred, Conditional> }>,
  execute: (
    runtime: BoundDeviceRuntime<
      RuntimeUse<PlatformRuntimeOperations, Required, Preferred, Conditional>
    >,
    dispatchContext: DaemonCommandContext,
  ) => Promise<Record<string, unknown> | void>,
): Promise<ResolvedGenericExecution> {
  const admission = await admitRuntimeUse(request);
  if (admission.type === 'response') return { ok: false, response: admission.response };
  const runtime = admission.runtime;
  return {
    ok: true,
    execute: async ({ dispatchContext }) => await execute(runtime, dispatchContext),
  };
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
