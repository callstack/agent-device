import type {
  PlatformRuntimeOperations,
  RuntimeOperationFact,
  RuntimeOperationKey,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import type { SessionStore } from '../session-store.ts';
import type { DaemonRequest, DaemonResponse } from '../types.ts';
import { errorResponse } from './response.ts';

export type RuntimeCommandHandlerParams = Readonly<{
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
}>;

/** Shared facts-first admission for request-scoped runtime command handlers. */
export function unavailableRuntimeOperationResponse(
  command: string,
  fact: RuntimeOperationFact,
): DaemonResponse | undefined {
  if (fact.available) return undefined;
  return errorResponse(
    'UNSUPPORTED_OPERATION',
    `${command} is not supported on this device`,
    { reason: fact.reason },
    fact.hint ? { hint: fact.hint } : undefined,
  );
}

export function requireRuntimeFacts(
  inspectFacts: InspectDeviceRuntimeFacts | undefined,
): InspectDeviceRuntimeFacts {
  if (inspectFacts) return inspectFacts;
  throw new AppError('COMMAND_FAILED', 'Device runtime facts inspection is unavailable.');
}

export async function inspectRequiredRuntimeUse<
  const Use extends Readonly<{
    required: readonly RuntimeOperationKey<PlatformRuntimeOperations>[];
  }>,
>(
  params: Readonly<{
    device: DeviceInfo;
    use: Use;
    inspectFacts?: InspectDeviceRuntimeFacts;
  }>,
): Promise<
  | Readonly<{ admitted: true }>
  | Readonly<{
      admitted: false;
      operation: Use['required'][number];
      fact: RuntimeOperationFact;
    }>
> {
  const facts = await requireRuntimeFacts(params.inspectFacts)(params.device);
  for (const operation of params.use.required) {
    const fact = facts.operations[operation];
    if (!fact.available) return { admitted: false, operation, fact };
  }
  return { admitted: true };
}

export function requireRuntimeBinding(
  bindDevice: BindDeviceRuntime | undefined,
): BindDeviceRuntime {
  if (bindDevice) return bindDevice;
  throw new AppError('COMMAND_FAILED', 'Device runtime binding is unavailable.');
}
