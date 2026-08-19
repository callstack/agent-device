import {
  elementReadRuntimePlan,
  type CaptureSnapshotInput,
  type ElementReadRuntimePlan,
  type ElementTextRuntimeOperations,
  type ReadTextAtPointInput,
  type SnapshotResult,
} from '@agent-device/contracts/platform';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from './request-runtime-binding.ts';
import type { DaemonResponse, SessionState } from './types.ts';
import { noActiveSessionError } from './handlers/response.ts';
import {
  admitRuntimePlan,
  requireRuntimeBinding,
  unavailableRuntimeOperationResponse,
  unwrapAdmittedRuntimePlan,
  type AdmittedRuntimePlan,
} from './handlers/session-runtime-admission.ts';

/**
 * The operations `get` executes with. `captureSnapshot` is required, so it is non-optional here;
 * `readTextAtPoint` is the declared preferred operation and is present only on owners whose facts
 * advertise it. Its absence changes which text `get` can read, never whether `get` can run.
 */
export type BoundGetRuntimeOperations = Readonly<{
  captureSnapshot(input: CaptureSnapshotInput): Promise<SnapshotResult>;
  readTextAtPoint?: ElementTextRuntimeOperations['readTextAtPoint'];
}>;

export type ResolvedGetRuntime =
  | Readonly<{
      ok: true;
      session: SessionState;
      device: SessionState['device'];
      operations: BoundGetRuntimeOperations;
    }>
  | Readonly<{ ok: false; response: DaemonResponse }>;

/**
 * `get`'s one facts-first admission and one binding. The session owns the device, so there is no
 * separate target resolution: admission inspects that device's owner facts once, refuses before
 * binding when the required capture is unavailable, then binds exactly once on the admitted
 * device through the admitted plan's token.
 */
export async function resolveBoundGetRuntime(
  params: Readonly<{
    session: SessionState | undefined;
    inspectFacts?: InspectDeviceRuntimeFacts;
    bindDevice?: BindDeviceRuntime;
  }>,
): Promise<ResolvedGetRuntime> {
  const { session } = params;
  if (!session) return { ok: false, response: noActiveSessionError() };
  const device = session.device;
  const admission = await admitRuntimePlan({
    device,
    plan: elementReadRuntimePlan,
    inspectFacts: params.inspectFacts,
  });
  if (!admission.admitted) {
    return { ok: false, response: unavailableRuntimeOperationResponse('get', admission.fact)! };
  }
  return {
    ok: true,
    session,
    device,
    operations: await bindGetRuntime(params.bindDevice, admission),
  };
}

/**
 * Binds only an admitted plan, on the device it was admitted for: the token is minted by
 * `admitRuntimePlan` alone and unwrapped by exact identity, so a bare plan, a separate device, or
 * a look-alike cannot reach these operations.
 */
async function bindGetRuntime(
  bindDevice: BindDeviceRuntime | undefined,
  admission: AdmittedRuntimePlan<ElementReadRuntimePlan>,
): Promise<BoundGetRuntimeOperations> {
  const bind = requireRuntimeBinding(bindDevice);
  const { device, plan } = unwrapAdmittedRuntimePlan(admission);
  return selectElementReadOperations(await bind(device, plan.use));
}

/**
 * Mirrors the snapshot binder's `BoundSnapshotOperation`: the operation this projection names is
 * non-optional, so a value of this type IS the proof that the owner advertised it.
 */
type BoundElementReadOperation<Operation extends keyof BoundElementReadCatalog> = Readonly<{
  operations: Readonly<Pick<BoundElementReadCatalog, Operation>>;
}>;

type BoundElementReadCatalog = Readonly<{
  captureSnapshot(input: CaptureSnapshotInput): Promise<SnapshotResult>;
  readTextAtPoint: ElementTextRuntimeOperations['readTextAtPoint'];
}>;

type NarrowedElementReadRuntime = Readonly<{
  operations: Readonly<{
    captureSnapshot(input: CaptureSnapshotInput): Promise<SnapshotResult>;
    readTextAtPoint?: ElementTextRuntimeOperations['readTextAtPoint'];
  }>;
}>;

/**
 * The lexical owner of `get`'s required capture call. The preferred read is handed to its own
 * owner below only when the owner facts advertised it: the narrowed projection is *constructed*
 * from a non-undefined local, so presence is carried by the type system rather than repaired
 * with a non-null assertion or a defensive throw.
 */
function selectElementReadOperations(
  runtime: NarrowedElementReadRuntime,
): BoundGetRuntimeOperations {
  const readTextAtPoint = runtime.operations.readTextAtPoint;
  return Object.freeze({
    captureSnapshot: async (input: CaptureSnapshotInput) =>
      await runtime.operations.captureSnapshot(input),
    ...(readTextAtPoint
      ? { readTextAtPoint: selectElementTextRead({ operations: { readTextAtPoint } }) }
      : {}),
  });
}

/** The lexical owner of `get`'s preferred element-text read. */
function selectElementTextRead(
  runtime: BoundElementReadOperation<'readTextAtPoint'>,
): ElementTextRuntimeOperations['readTextAtPoint'] {
  return async (input: ReadTextAtPointInput) => await runtime.operations.readTextAtPoint(input);
}
