import type { TvRemoteInput } from '@agent-device/contracts/tv-remote-runtime';
import { tvRemoteRuntimeUse } from '@agent-device/contracts/platform-runtime-operations';
import type { BoundDeviceRuntime } from '@agent-device/contracts/platform-runtime';
import { parseTvRemoteButton, type TvRemoteButton } from '@agent-device/contracts/tv-remote';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { successText } from '@agent-device/kernel/success-text';
import { requireIntInRange } from '../core/validation.ts';
import type { DaemonCommandContext } from './context.ts';
import type { ResolvedGenericExecution } from './request-generic-dispatch.ts';
import { resolveBoundGenericRuntime, type RuntimeAdmissionBindings } from './runtime-admission.ts';
import { runtimeExecutionFromContext } from './snapshot-runtime-capture-input.ts';

/** `tv-remote <button>`, on the same parse the retired leaf used. */
function readTvRemoteButton(positionals: readonly string[]): TvRemoteButton {
  if (positionals.length !== 1) {
    throw new AppError('INVALID_ARGS', 'tv-remote requires exactly one button');
  }
  return parseTvRemoteButton(positionals[0]);
}

/** The neutral intent one TV remote press carries, projected from a resolved command context. */
function tvRemoteInput(
  button: TvRemoteButton,
  durationMs: number | undefined,
  context: DaemonCommandContext,
): TvRemoteInput {
  return {
    button,
    durationMs,
    ...(context.appBundleId === undefined ? {} : { options: { appBundleId: context.appBundleId } }),
    execution: runtimeExecutionFromContext(context),
  };
}

/**
 * The one place `tv-remote` reaches a device (ADR 0019). Admission inspects the exact owner's
 * `tvRemote` fact and binds once, before the dispatcher runs, so an owner that cannot drive a
 * remote is refused rather than discovered mid-execution.
 */
export async function resolveBoundTvRemoteRuntime(
  params: {
    device: DeviceInfo;
    positionals: readonly string[];
    durationMs?: number;
  } & RuntimeAdmissionBindings,
): Promise<ResolvedGenericExecution> {
  const button = readTvRemoteButton(params.positionals);
  const durationMs =
    params.durationMs === undefined
      ? undefined
      : requireIntInRange(params.durationMs, 'durationMs', 0, 10_000);
  return await resolveBoundGenericRuntime(
    {
      command: 'tv-remote',
      device: params.device,
      use: tvRemoteRuntimeUse,
      inspectFacts: params.inspectFacts,
      bindDevice: params.bindDevice,
    },
    (runtime, context) => executeTvRemote(runtime, button, durationMs, context),
  );
}

/**
 * The ONE place a bound `tvRemote` executes (R45). Typed off `typeof tvRemoteRuntimeUse` rather
 * than a hand-restated operations shape, so a change to what `tvRemote` binds can't silently
 * drift here.
 */
async function executeTvRemote(
  runtime: BoundDeviceRuntime<typeof tvRemoteRuntimeUse>,
  button: TvRemoteButton,
  durationMs: number | undefined,
  context: DaemonCommandContext,
): Promise<Record<string, unknown>> {
  await runtime.operations.tvRemote(tvRemoteInput(button, durationMs, context));
  return {
    action: 'tv-remote',
    button,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...successText(`Pressed TV remote ${button}`),
  };
}
