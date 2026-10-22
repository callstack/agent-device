import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { resolveDeviceReadinessRuntimePlan } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { asAppError } from '@agent-device/kernel/errors';
import { errorResponse } from '@agent-device/kernel/contracts';
import { resolveAndroidSerialAllowlist } from '@agent-device/kernel/device-isolation';
import {
  requireSessionOrExplicitSelector,
  resolvePowerCommandDevice,
} from '../../resources/session-device-resolution.ts';
import {
  admitRuntimeOperations,
  type UnavailableRuntimeResponse,
} from '../../core/runtime-admission.ts';
import { startupDeadlineAtMs } from '../startup-deadline.ts';
import type { RuntimeCommandHandlerParams } from '../../core/session-runtime-admission.ts';
import { deviceStatusReportResponse } from './session-device-status-response.ts';

/** `boot --headless` reports an unsupported cell as a request error, not a device capability gap. */
function bootUnavailableResponse(headless: boolean): UnavailableRuntimeResponse {
  return (unavailable) =>
    errorResponse(
      headless ? 'INVALID_ARGS' : 'UNSUPPORTED_OPERATION',
      headless
        ? 'boot --headless is supported only for Android emulators.'
        : 'boot is not supported on this device',
      undefined,
      unavailable.hint ? { hint: unavailable.hint } : undefined,
    );
}

function hasAndroidAvdIdentity(
  selectedName: string | undefined,
  sessionDevice: DeviceInfo | undefined,
): boolean {
  return Boolean(
    selectedName?.trim() ||
    (sessionDevice?.platform === 'android' && sessionDevice.kind === 'emulator'),
  );
}

/**
 * Which device this boot targets. A headless plan whose selector carries no Android AVD identity
 * turns the resolver's `DEVICE_NOT_FOUND` into the argument error that names the missing
 * `--device <avd-name>`; every other resolution failure propagates unchanged.
 */
async function resolveBootTargetDevice(
  params: RuntimeCommandHandlerParams,
  headless: boolean,
): Promise<DeviceInfo | { refusal: DaemonResponse }> {
  const { sessionName, sessionStore, req, platformServices } = params;
  const session = sessionStore.get(sessionName);
  const flags = req.flags ?? {};
  try {
    const device = await resolvePowerCommandDevice({
      session,
      flags,
      env: sessionStore.host.env,
      platformServices,
    });
    if (flags.target && (device.target ?? 'mobile') !== flags.target) {
      return {
        refusal: errorResponse(
          'DEVICE_NOT_FOUND',
          `No ${device.platform} device found matching --target ${flags.target}.`,
        ),
      };
    }
    return device;
  } catch (error) {
    if (
      headless &&
      !hasAndroidAvdIdentity(flags.device, session?.device) &&
      asAppError(error).code === 'DEVICE_NOT_FOUND'
    ) {
      return {
        refusal: errorResponse(
          'INVALID_ARGS',
          'boot --headless requires --device <avd-name> (or an Android emulator session target).',
        ),
      };
    }
    throw error;
  }
}

/** Brings the selected device up, headless for an Android AVD plan, through one admitted runtime. */
export async function handleBootCommand(
  params: RuntimeCommandHandlerParams,
): Promise<DaemonResponse> {
  const flags = params.req.flags ?? {};
  const guard = requireSessionOrExplicitSelector(
    params.req.command,
    params.sessionStore.get(params.sessionName),
    flags,
  );
  if (guard) return guard;

  const resolvedAndroidSerialAllowlist = resolveAndroidSerialAllowlist(
    flags.androidDeviceAllowlist,
    params.host.env,
  );
  const androidSerialAllowlist = resolvedAndroidSerialAllowlist
    ? [...resolvedAndroidSerialAllowlist].sort()
    : undefined;
  const plan = resolveDeviceReadinessRuntimePlan({ headless: flags.headless === true });

  const target = await resolveBootTargetDevice(params, plan.kind === 'boot-target-headless');
  if ('refusal' in target) return target.refusal;

  const admitted = await admitRuntimeOperations({
    command: 'boot',
    device: target,
    required: plan.use.required,
    inspectFacts: params.inspectFacts,
    platformServices: params.platformServices,
    bindDevice: params.bindDevice,
    unavailableResponse: bootUnavailableResponse(plan.kind === 'boot-target-headless'),
  });
  if (admitted.type === 'response') return admitted.response;

  const input = {
    serial: flags.serial,
    androidSerialAllowlist,
    deadlineAtMs: startupDeadlineAtMs(flags.timeoutMs),
  };
  const device =
    plan.kind === 'boot-target-headless'
      ? await (await admitted.bind(target, plan.use)).operations.bootTargetHeadless(input)
      : await (await admitted.bind(target, plan.use)).operations.bootTarget(input);

  return deviceStatusReportResponse(device, { booted: true });
}
