import { telephonyRuntimeUse } from '@agent-device/contracts/platform-runtime-operations';
import type { BoundDeviceRuntime } from '@agent-device/contracts/platform-runtime';
import {
  parseTelephonyPositionals,
  type TelephonyCommandResult,
  type TelephonyEventInput,
} from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { ResolvedGenericExecution } from '../core/generic-leaf-execution.ts';
import {
  resolveBoundGenericRuntime,
  type RuntimeAdmissionBindings,
} from '../core/runtime-admission.ts';

/**
 * The one place `telephony` reaches a device (ADR 0019). The event is parsed before admission, so
 * an invalid number or text is refused before any owner is inspected or bound.
 */
export async function resolveBoundTelephonyRuntime(
  params: {
    device: DeviceInfo;
    positionals: readonly string[];
  } & RuntimeAdmissionBindings,
): Promise<ResolvedGenericExecution> {
  const input = parseTelephonyPositionals(params.positionals);
  return await resolveBoundGenericRuntime(
    {
      command: 'telephony',
      device: params.device,
      use: telephonyRuntimeUse,
      inspectFacts: params.inspectFacts,
      platformServices: params.platformServices,
      bindDevice: params.bindDevice,
    },
    (runtime) => executeTelephonyEvent(runtime, input),
  );
}

const CALL_EVENT_MESSAGES = {
  call: 'Simulated an incoming call from',
  accept: 'Accepted the call from',
  cancel: 'Ended the call from',
} as const satisfies Record<Exclude<TelephonyEventInput['action'], 'sms'>, string>;

async function executeTelephonyEvent(
  runtime: BoundDeviceRuntime<typeof telephonyRuntimeUse>,
  input: TelephonyEventInput,
): Promise<TelephonyCommandResult> {
  await runtime.operations.sendTelephonyEvent(input);
  if (input.action === 'sms') {
    return {
      action: input.action,
      number: input.number,
      textLength: Array.from(input.text).length,
      message: `Simulated an incoming SMS from ${input.number}`,
    };
  }
  return {
    action: input.action,
    number: input.number,
    message: `${CALL_EVENT_MESSAGES[input.action]} ${input.number}`,
  };
}
