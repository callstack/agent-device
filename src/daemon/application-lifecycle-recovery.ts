import {
  type RuntimeHintValues,
  hasRuntimeTransportHintValues,
} from '@agent-device/contracts/application-lifecycle-runtime';
import {
  finalizeApplicationCloseRuntimeUse,
  finalizeApplicationCloseWithRuntimeHintClearUse,
} from '@agent-device/contracts/application-lifecycle-runtime-plan';
import {
  type DeviceBinding,
  type DeviceRuntimeGateway,
  type RuntimeFacts,
  type RuntimeOperationKey,
  narrowDeviceBinding,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { AppError } from '@agent-device/kernel/errors';
import type { SessionState } from './types.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from './request-runtime-binding.ts';

type SessionFinalization = Readonly<{
  inspectFacts: InspectDeviceRuntimeFacts;
  bind: BindDeviceRuntime;
  session: SessionState;
  stateDir: string;
  runtimeHints: RuntimeHintValues;
  daemonShutdown?: boolean;
}>;

/**
 * Both finalization entry points admit the same facts and run the same effects; they differ only
 * in how the selected owner is bound and disposed, which each entry point supplies as `bind`.
 */
async function finalizeSessionApplicationLifecycle(params: SessionFinalization): Promise<void> {
  const { inspectFacts, bind, session, stateDir, runtimeHints } = params;
  const input = {
    ...finalizationInput(session, stateDir),
    ...(params.daemonShutdown ? { daemonShutdown: true } : {}),
  };
  if (!requiresRuntimeHintCleanup(session, runtimeHints)) {
    const use = finalizeApplicationCloseRuntimeUse;
    assertLifecycleFacts(await inspectFacts(session.device), use.required, session);
    await (await bind(session.device, use)).operations.finalizeApplicationClose(input);
    return;
  }
  const use = finalizeApplicationCloseWithRuntimeHintClearUse;
  assertLifecycleFacts(await inspectFacts(session.device), use.required, session);
  const runtime = await bind(session.device, use);
  await runtime.operations.finalizeApplicationClose(input);
  await runtime.operations.clearRuntimeHints({
    appId: session.appBundleId,
    values: runtimeHints,
  });
}

export async function finalizeBoundSessionApplicationLifecycle(params: {
  inspectFacts: InspectDeviceRuntimeFacts;
  bindDevice: BindDeviceRuntime;
  session: SessionState;
  stateDir: string;
  runtimeHints: RuntimeHintValues;
}): Promise<void> {
  await finalizeSessionApplicationLifecycle({ ...params, bind: params.bindDevice });
}

/**
 * Finish a persisted session's lifecycle-owned resources during daemon shutdown. The selected
 * owner is admitted from eager facts, then bound through the provider-first gateway exactly once.
 * A platform finalization failure remains primary over binding disposal failure.
 */
export async function finalizeDaemonSessionApplicationLifecycle(params: {
  gateway: DeviceRuntimeGateway<PlatformRuntimeOperations>;
  scope: PlatformRequestScope;
  session: SessionState;
  stateDir: string;
  runtimeHints: RuntimeHintValues;
}): Promise<void> {
  const { gateway, scope, session, stateDir, runtimeHints } = params;
  // Bound lazily so an unsupported cell still fails on facts alone, without allocating an owner.
  let binding: DeviceBinding<PlatformRuntimeOperations> | undefined;
  try {
    await finalizeSessionApplicationLifecycle({
      inspectFacts: async (device) => await gateway.inspectFacts(device),
      bind: async (device, use) => {
        binding ??= await gateway.bind({ device, intent: { kind: 'ordinary' }, scope });
        return narrowDeviceBinding(binding, use);
      },
      session,
      stateDir,
      runtimeHints,
      daemonShutdown: true,
    });
  } catch (operationError) {
    try {
      await binding?.[Symbol.asyncDispose]();
    } catch (cleanupError) {
      scope.diagnostics.emit({
        level: 'error',
        phase: 'daemon_lifecycle_binding_cleanup_failed',
        data: {
          session: session.name,
          error: errorMessage(cleanupError),
          operationError: errorMessage(operationError),
        },
      });
    }
    throw operationError;
  }
  await binding?.[Symbol.asyncDispose]();
}

function assertLifecycleFacts(
  facts: RuntimeFacts<PlatformRuntimeOperations>,
  operations: readonly RuntimeOperationKey<PlatformRuntimeOperations>[],
  session: SessionState,
): void {
  for (const operation of operations) {
    const fact = facts.operations[operation];
    if (fact?.available) continue;
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      `Session lifecycle ${operation} is not supported on this device.`,
      {
        reason: fact?.reason,
        ...(fact?.hint === undefined ? {} : { hint: fact.hint }),
        deviceId: session.device.id,
      },
    );
  }
}

function finalizationInput(session: SessionState, stateDir: string) {
  return {
    appBundleId: session.appBundleId,
    surface: session.surface ?? 'app',
    retainRunner: false,
    stateDir,
  };
}

function requiresRuntimeHintCleanup(
  session: SessionState,
  runtimeHints: RuntimeHintValues,
): boolean {
  return session.appBundleId !== undefined && hasRuntimeTransportHintValues(runtimeHints);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
