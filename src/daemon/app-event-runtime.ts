import type { AppEventInput } from '@agent-device/contracts/app-event-runtime';
import { appEventRuntimeUse } from '@agent-device/contracts/platform-runtime-operations';
import type { BoundDeviceRuntime } from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { parseTriggerAppEventArgs, resolveAppEventUrl } from '../core/app-events.ts';
import { successText } from '@agent-device/kernel/success-text';
import type { DaemonCommandContext } from './context.ts';
import { admitRuntimeUse, type RuntimeAdmissionBindings } from './runtime-admission.ts';
import { runtimeExecutionFromContext } from './snapshot-runtime-capture-input.ts';
import type { DaemonFailureResponse } from './response.ts';
import type { DeviceReadyOptions } from './device-ready.ts';

/**
 * What the admit-then-bind step reports: either the refusal an unadmitted cell produced, or the
 * one bound invocation to run once the caller has expired the ref frame (ADR 0014).
 */
export type ResolvedAppEventExecution =
  | Readonly<{ ok: false; response: DaemonFailureResponse }>
  | Readonly<{
      ok: true;
      execute: (context: DaemonCommandContext) => Promise<Record<string, unknown>>;
    }>;

/**
 * The ONE place a bound `trigger-app-event` executes (R57). Argument parsing and URL resolution
 * stay here rather than moving into the owner: the event name pattern, the payload size limit,
 * and the per-platform `AGENT_DEVICE_*_APP_EVENT_URL_TEMPLATE` are daemon policy, not device
 * mechanics. They also stay downstream of admission, where the retired `dispatchCommand` ran
 * them, so an unsupported device still reports the unsupported cell rather than an argument error.
 */
async function executeAppEvent(
  runtime: BoundDeviceRuntime<typeof appEventRuntimeUse>,
  device: DeviceInfo,
  context: DaemonCommandContext,
  positionals: readonly string[],
): Promise<Record<string, unknown>> {
  const { eventName, payload } = parseTriggerAppEventArgs([...positionals]);
  const eventUrl = resolveAppEventUrl(device, eventName, payload);
  const input: AppEventInput = {
    eventUrl,
    ...(context.appBundleId === undefined ? {} : { options: { appBundleId: context.appBundleId } }),
    execution: runtimeExecutionFromContext(context),
  };
  await runtime.operations.triggerAppEvent(input);
  return {
    event: eventName,
    eventUrl,
    transport: 'deep-link',
    ...successText(`Triggered app event: ${eventName}`),
  };
}

/**
 * The one place `trigger-app-event` reaches a device (ADR 0019 §9). Admission inspects the exact
 * owner's `triggerAppEvent` fact and binds once, before the frame expires and before any
 * argument is read.
 */
export async function resolveBoundAppEventRuntime(
  params: Readonly<{
    device: DeviceInfo;
    positionals: readonly string[];
    readiness?: DeviceReadyOptions;
  }> &
    RuntimeAdmissionBindings,
): Promise<ResolvedAppEventExecution> {
  const { device, positionals, inspectFacts, bindDevice, readiness } = params;
  const admission = await admitRuntimeUse({
    command: 'trigger-app-event',
    device,
    use: appEventRuntimeUse,
    inspectFacts,
    bindDevice,
    readiness,
  });
  if (admission.type === 'response') return { ok: false, response: admission.response };
  const runtime = admission.runtime;
  return {
    ok: true,
    execute: (context) => executeAppEvent(runtime, device, context, positionals),
  };
}
