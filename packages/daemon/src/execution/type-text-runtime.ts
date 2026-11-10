import { typeTextRuntimeUse } from '@agent-device/contracts/platform-runtime-operations';
import type {
  TypeTextInput,
  TypeTextRuntimeOperations,
} from '@agent-device/contracts/type-text-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { successText } from '@agent-device/kernel/success-text';
import { findMistargetedTypeRefToken } from './type-target-warning.ts';
import { requireIntInRange } from '@agent-device/kernel/validation';
import type { DaemonCommandContext } from '../core/context.ts';
import { admitRuntimeUse, type RuntimeAdmissionBindings } from '../core/runtime-admission.ts';
import { runtimeExecutionFromContext } from '../core/snapshot-runtime-capture-input.ts';
import type { DaemonFailureResponse } from '@agent-device/kernel/contracts';

/** What the executor needs: only the bound operation, however broad the bind that carried it. */
type BoundTypeTextOperations = Readonly<{
  operations: Readonly<{ typeText: TypeTextRuntimeOperations['typeText'] }>;
}>;

/** A validated `type` request: the joined text and the bounded keystroke delay. */
export type TypeTextRequest = Readonly<{ text: string; delayMs: number }>;

/**
 * Executes one validated text entry against an already-admitted binding. Callers parse with
 * `parseTypeTextRequest` first, so an invalid request is refused before any side effect.
 */
export type BoundTypeTextExecutor = (
  request: TypeTextRequest,
  context: DaemonCommandContext,
) => Promise<Record<string, unknown>>;

export type ResolvedTypeTextRuntime =
  | Readonly<{ ok: false; response: DaemonFailureResponse }>
  | Readonly<{ ok: true; typeText: BoundTypeTextExecutor }>;

/**
 * The one place `type` reaches a device (ADR 0019). Admission inspects the exact owner's
 * `typeText` fact and binds once, before anything executes, so an owner without text entry is
 * refused where the capability bucket used to refuse — not discovered mid-execution. Shared by
 * the `type` handler and find's `type` leg, so both reach the device through one operation.
 */
export async function resolveBoundTypeTextRuntime(
  params: { device: DeviceInfo } & RuntimeAdmissionBindings,
): Promise<ResolvedTypeTextRuntime> {
  const admission = await admitRuntimeUse({
    command: 'type',
    device: params.device,
    use: typeTextRuntimeUse,
    inspectFacts: params.inspectFacts,
    platformServices: params.platformServices,
    bindDevice: params.bindDevice,
  });
  if (admission.type === 'response') return { ok: false, response: admission.response };
  const runtime = admission.runtime;
  return {
    ok: true,
    typeText: async (request, context) => await executeBoundTypeText(runtime, request, context),
  };
}

/**
 * Validates the positionals of `type`: the text is the positionals joined by spaces, and
 * `delay-ms` is bounded to 0-10 000. `rejectRefTarget` refuses a leading snapshot ref, which is a
 * mistargeted `fill`; find's `type` leg passes false because its value is always text.
 */
export function parseTypeTextRequest(
  positionals: readonly string[],
  context: DaemonCommandContext,
  options: { rejectRefTarget: boolean },
): TypeTextRequest {
  const mistargetedRef = options.rejectRefTarget
    ? findMistargetedTypeRefToken(positionals[0])
    : null;
  if (mistargetedRef) {
    throw new AppError(
      'INVALID_ARGS',
      `type does not accept a target ref like "${mistargetedRef}"`,
      {
        hint: `Use fill ${mistargetedRef} "text" to target that field, or press ${mistargetedRef} then type "text" to append.`,
      },
    );
  }
  const text = positionals.join(' ');
  if (!text) throw new AppError('INVALID_ARGS', 'type requires text');
  const delayMs = requireIntInRange(context.delayMs ?? 0, 'delay-ms', 0, 10_000);
  return { text, delayMs };
}

export async function executeBoundTypeText(
  runtime: BoundTypeTextOperations,
  { text, delayMs }: TypeTextRequest,
  context: DaemonCommandContext,
): Promise<Record<string, unknown>> {
  const backendResult = await runtime.operations.typeText(typeTextInput(text, delayMs, context));
  const textEntryRoute = backendResult?.textEntryRoute;
  return {
    ...(textEntryRoute === undefined ? {} : { textEntryRoute }),
    text,
    delayMs,
    ...successText(`Typed ${Array.from(text).length} chars`),
  };
}

/** The neutral intent one text entry carries, projected from a resolved command context. */
function typeTextInput(
  text: string,
  delayMs: number,
  context: DaemonCommandContext,
): TypeTextInput {
  return {
    text,
    delayMs,
    ...(context.appBundleId === undefined ? {} : { options: { appBundleId: context.appBundleId } }),
    execution: runtimeExecutionFromContext(context),
  };
}
