import { resolveAndroidApp } from '../../platforms/android/app-lifecycle.ts';
import { resolveIosApp } from '../../platforms/apple/core/apps.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import { normalizeError } from '../../kernel/errors.ts';
import type { SessionState } from '../types.ts';
import { appendDoctorCheck } from './session-doctor-output.ts';
import type { DoctorCheck } from './session-doctor-types.ts';

export async function appendAppChecks(
  checks: DoctorCheck[],
  params: { device: DeviceInfo; session: SessionState | undefined; targetApp?: string },
): Promise<void> {
  const { device, targetApp, session } = params;
  if (!targetApp) {
    return;
  }

  try {
    const resolved =
      device.platform === 'android'
        ? (await resolveAndroidApp(device, targetApp)).value
        : device.platform === 'ios' || device.platform === 'macos'
          ? await resolveIosApp(device, targetApp)
          : targetApp;
    appendDoctorCheck(checks, {
      id: 'target-app',
      status: 'pass',
      summary: `Target app is discoverable: ${resolved}`,
      evidence: { requested: targetApp, resolved, sessionApp: session?.appBundleId },
    });
  } catch (error) {
    const normalized = normalizeError(error);
    appendDoctorCheck(checks, {
      id: 'target-app',
      status: 'fail',
      summary: `Target app is not discoverable: ${targetApp}`,
      hint: normalized.hint ?? 'Install the app or pass the exact package/bundle id.',
      command: `agent-device apps --platform ${device.platform}`,
      evidence: { code: normalized.code, message: normalized.message },
    });
  }
}
