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
      status: device.booted === false ? 'fail' : 'pass',
      summary: deviceSummary(device),
      command:
        device.booted === false ? `agent-device boot --platform ${device.platform}` : undefined,
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

function deviceSummary(device: DeviceInfo): string {
  const label = `${device.name} (${device.platform}${device.target ? `/${device.target}` : ''})`;
  if (device.booted === false) {
    return `Selected ${label}, but it is not booted.`;
  }
  if (device.booted === true) {
    return `Selected ${label}; device is booted.`;
  }
  return `Selected ${label}; boot state is not reported for this target.`;
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
