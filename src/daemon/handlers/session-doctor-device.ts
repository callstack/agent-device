import type { DeviceInfo } from '../../utils/device.ts';
import { normalizeError } from '../../utils/errors.ts';
import type { DaemonRequest, SessionState } from '../types.ts';
import { resolveCommandDevice } from './session-device-utils.ts';
import type { DoctorCheck, DoctorOptions } from './session-doctor-types.ts';
import { appendDoctorCheck } from './session-doctor-output.ts';

export async function appendDeviceCheck(
  checks: DoctorCheck[],
  req: DaemonRequest,
  session: SessionState | undefined,
): Promise<DeviceInfo | undefined> {
  try {
    const device = await resolveCommandDevice({ session, flags: req.flags, ensureReady: false });
    appendDoctorCheck(checks, {
      id: 'device',
      status: 'pass',
      summary: `Selected ${device.name} (${device.platform}${device.target ? `/${device.target}` : ''})`,
      evidence: {
        id: device.id,
        name: device.name,
        platform: device.platform,
        kind: device.kind,
        target: device.target ?? 'mobile',
        booted: device.booted,
      },
    });
    return device;
  } catch (error) {
    const normalized = normalizeError(error);
    appendDoctorCheck(checks, {
      id: 'device',
      status: 'fail',
      summary: normalized.message,
      hint: normalized.hint,
      command: 'agent-device devices',
      evidence: { code: normalized.code, details: normalized.details },
    });
    return undefined;
  }
}

export function deviceReadinessCheck(device: DeviceInfo): DoctorCheck {
  if (device.booted === false) {
    return {
      id: 'device-readiness',
      status: 'fail',
      summary: `${device.name} is present but not booted.`,
      command: `agent-device boot --platform ${device.platform}`,
      evidence: { booted: false },
    };
  }
  return {
    id: 'device-readiness',
    status: 'pass',
    summary:
      device.booted === true
        ? `${device.name} is booted.`
        : `${device.name} readiness is selected; boot state is not reported for this target.`,
    evidence: { booted: device.booted },
  };
}

export function platformScopeChecks(device: DeviceInfo, options: DoctorOptions): DoctorCheck[] {
  if (
    (options.kind === 'react-native' || options.kind === 'expo') &&
    device.platform !== 'ios' &&
    device.platform !== 'android'
  ) {
    return [
      {
        id: 'platform-scope',
        status: 'info',
        summary: `${options.kind} checks are app-mobile focused; ${device.platform} doctor covers device/session readiness only.`,
      },
    ];
  }
  if (device.platform === 'android' && options.kind !== 'auto') {
    return [
      {
        id: 'android-routing',
        status: 'info',
        summary:
          'Android URL opens can use host localhost automatically; package launches may still need adb reverse.',
        command: `adb -s ${device.id} reverse tcp:${options.metroPort} tcp:${options.metroPort}`,
      },
    ];
  }
  return [];
}
