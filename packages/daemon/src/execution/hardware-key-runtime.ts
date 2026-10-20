import type { HardwareKeyInput } from '@agent-device/contracts/hardware-key-runtime';
import { hardwareKeyRuntimeUse } from '@agent-device/contracts/platform-runtime-operations';
import type { BoundDeviceRuntime } from '@agent-device/contracts/platform-runtime';
import { parseHardwareKey, type HardwareKeyToken } from '@agent-device/contracts/hardware-key';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { successText } from '@agent-device/kernel/success-text';
import type { DaemonCommandContext } from '../core/context.ts';
import type { ResolvedGenericExecution } from '../core/generic-leaf-execution.ts';
import {
  resolveBoundGenericRuntime,
  type RuntimeAdmissionBindings,
} from '../core/runtime-admission.ts';
import { runtimeExecutionFromContext } from '../core/snapshot-runtime-capture-input.ts';

/** `hardware-key <key>`: one key, parsed the same way the CLI positional is. */
function readHardwareKey(positionals: readonly string[]): HardwareKeyToken {
  if (positionals.length !== 1) {
    throw new AppError('INVALID_ARGS', 'hardware-key requires exactly one key');
  }
  return parseHardwareKey(positionals[0]);
}

/** The neutral intent one key press carries, projected from a resolved command context. */
function hardwareKeyInput(key: HardwareKeyToken, context: DaemonCommandContext): HardwareKeyInput {
  return {
    key,
    ...(context.appBundleId === undefined ? {} : { options: { appBundleId: context.appBundleId } }),
    execution: runtimeExecutionFromContext(context),
  };
}

/**
 * The one place `hardware-key` reaches a device (ADR 0019). The key is parsed before admission, so
 * a malformed request never inspects or binds a device. Admission inspects the exact owner's
 * `hardwareKey` fact and binds once, before the dispatcher runs, so an owner without a key-event
 * channel is refused rather than discovered mid-execution.
 */
export async function resolveBoundHardwareKeyRuntime(
  params: { device: DeviceInfo; positionals: readonly string[] } & RuntimeAdmissionBindings,
): Promise<ResolvedGenericExecution> {
  const key = readHardwareKey(params.positionals);
  return await resolveBoundGenericRuntime(
    {
      command: 'hardware-key',
      device: params.device,
      use: hardwareKeyRuntimeUse,
      inspectFacts: params.inspectFacts,
      platformServices: params.platformServices,
      bindDevice: params.bindDevice,
    },
    (runtime, context) => executeHardwareKey(runtime, key, context),
  );
}

/**
 * The ONE place a bound `hardwareKey` executes (R45). Typed off `typeof hardwareKeyRuntimeUse`
 * rather than a hand-restated operations shape, so a change to what `hardwareKey` binds can't
 * silently drift here.
 */
async function executeHardwareKey(
  runtime: BoundDeviceRuntime<typeof hardwareKeyRuntimeUse>,
  key: HardwareKeyToken,
  context: DaemonCommandContext,
): Promise<Record<string, unknown>> {
  await runtime.operations.hardwareKey(hardwareKeyInput(key, context));
  return { action: 'hardware-key', key, ...successText(`Pressed hardware key ${key}`) };
}
