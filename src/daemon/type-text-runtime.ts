import { typeTextRuntimeUse } from '@agent-device/contracts/platform-runtime-operations';
import type {
  TypeTextInput,
  TypeTextRuntimeOperations,
} from '@agent-device/contracts/type-text-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { successText } from '../utils/success-text.ts';
import { findMistargetedTypeRefToken } from '../utils/type-target-warning.ts';
import { requireIntInRange } from '../utils/validation.ts';
import type { DaemonCommandContext } from './context.ts';
import type { DaemonFailureResponse } from './handlers/response.ts';
import { admitRuntimeUse, type RuntimeAdmissionBindings } from './runtime-admission.ts';
import { runtimeExecutionFromContext } from './snapshot-runtime-capture-input.ts';

/** What the executor needs: only the bound operation, however broad the bind that carried it. */
type BoundTypeTextOperations = Readonly<{
  operations: Readonly<{ typeText: TypeTextRuntimeOperations['typeText'] }>;
}>;

/**
 * Executes one text entry against an already-admitted binding, byte-for-byte reproducing the
 * retired `handleTypeCommand` leaf: the mistargeted-ref rejection inspects the first positional,
 * the text is the positionals joined by spaces, `delay-ms` validates 0–10 000 from the resolved
 * context, and only `textEntryRoute` survives from the owner's result.
 */
export type BoundTypeTextExecutor = (
  positionals: readonly string[],
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
    bindDevice: params.bindDevice,
  });
  if (admission.type === 'response') return { ok: false, response: admission.response };
  const runtime = admission.runtime;
  return {
    ok: true,
    typeText: async (positionals, context) =>
      await executeBoundTypeText(runtime, positionals, context),
  };
}

export async function executeBoundTypeText(
  runtime: BoundTypeTextOperations,
  positionals: readonly string[],
  context: DaemonCommandContext,
): Promise<Record<string, unknown>> {
  const mistargetedRef = findMistargetedTypeRefToken(positionals[0]);
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
