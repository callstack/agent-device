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

/** Any command plan: the runtime use it binds, plus whatever discriminator the command needs. */
export type RuntimePlan = Readonly<{
  use: Readonly<{ required: readonly RuntimeOperationKey<PlatformRuntimeOperations>[] }>;
}>;

type AdmissionPayload<Plan extends RuntimePlan> = Readonly<{ device: DeviceInfo; plan: Plan }>;

// The payload store, keyed by the exact token object. Only `admitRuntimePlan` writes to it and
// only `unwrapAdmittedRuntimePlan` reads it, so what a binder consumes is looked up by identity
// — a Proxy around a token, a spread, or any other look-alike is a different object with no
// entry here and is refused. Nothing about the token's own surface can be trapped to lie.
const admissionPayloads = new WeakMap<object, AdmissionPayload<RuntimePlan>>();

// Minted only inside the class's static block below: the constructor is private and the class
// value is not exported, so no other module can construct one.
let mintAdmission: <Plan extends RuntimePlan>(
  device: DeviceInfo,
  plan: Plan,
) => AdmittedRuntimePlanToken<Plan>;

/**
 * Proof that every operation `plan.use` requires is available on `device`'s owner facts. The
 * token names the device the facts were read for, and a facts-first binder binds *that* device
 * from the token rather than taking one separately — so facts admitted for device A can never
 * bind device B.
 *
 * The token itself carries nothing readable: it is a nominal class (a `#private` member keeps
 * literals and spreads from being assignable to the type) whose payload lives in a module-private
 * WeakMap keyed by the token's identity. A binder gets at the device and plan only through
 * `unwrapAdmittedRuntimePlan`, which refuses any object that was not minted here — including a
 * Proxy around a real token, which types as the token but is a different identity. What remains
 * is a type assertion, which the cutover gate's manufactured-proof column rejects in src/daemon/.
 * A facts-first binder that requires the token therefore enforces "admit before bind" — for this
 * device, for this plan — at the seam.
 */
class AdmittedRuntimePlanToken<Plan extends RuntimePlan> {
  static {
    mintAdmission = (device, plan) => {
      const token = new AdmittedRuntimePlanToken<typeof plan>();
      // A frozen copy: the caller's DeviceInfo stays mutable in their hands, the admitted
      // identity does not move with it.
      admissionPayloads.set(token, { device: Object.freeze({ ...device }), plan });
      Object.freeze(token);
      return token;
    };
  }

  // Its presence makes the type nominal (no literal or spread satisfies it) and its phantom
  // parameter keeps the plan type on the token for the binder's narrowing; it is not the payload.
  readonly #plan: Plan | undefined;

  private constructor() {
    this.#plan = undefined;
  }

  get admitted(): true {
    void this.#plan;
    return true;
  }
}

export type AdmittedRuntimePlan<Plan extends RuntimePlan> = AdmittedRuntimePlanToken<Plan>;

/**
 * The device and plan an admission was minted for, by exact identity of the token. Throws for
 * anything else — a look-alike, a spread, a Proxy — because those were never admitted.
 */
export function unwrapAdmittedRuntimePlan<Plan extends RuntimePlan>(
  admission: AdmittedRuntimePlan<Plan>,
): AdmissionPayload<Plan> {
  const payload = admissionPayloads.get(admission);
  if (payload === undefined) {
    throw new AppError(
      'COMMAND_FAILED',
      'Runtime plan admission is not one minted by admitRuntimePlan; refusing to bind.',
    );
  }
  return payload as AdmissionPayload<Plan>;
}

export type RefusedRuntimePlan<Plan extends RuntimePlan> = Readonly<{
  admitted: false;
  operation: Plan['use']['required'][number];
  fact: RuntimeOperationFact;
}>;

/**
 * Facts-first admission (ADR 0019 §9): side-effect-free, no binding, no helper acquisition.
 * Refuses on the first required operation the owner facts report unavailable; otherwise returns
 * the admitted plan, which is what a facts-first binder takes instead of a bare plan.
 */
export async function admitRuntimePlan<const Plan extends RuntimePlan>(
  params: Readonly<{
    device: DeviceInfo;
    plan: Plan;
    inspectFacts?: InspectDeviceRuntimeFacts;
  }>,
): Promise<AdmittedRuntimePlan<Plan> | RefusedRuntimePlan<Plan>> {
  const facts = await requireRuntimeFacts(params.inspectFacts)(params.device);
  for (const operation of params.plan.use.required) {
    const fact = facts.operations[operation];
    if (!fact.available) return { admitted: false, operation, fact };
  }
  return mintAdmission(params.device, params.plan);
}

export function requireRuntimeBinding(
  bindDevice: BindDeviceRuntime | undefined,
): BindDeviceRuntime {
  if (bindDevice) return bindDevice;
  throw new AppError('COMMAND_FAILED', 'Device runtime binding is unavailable.');
}
