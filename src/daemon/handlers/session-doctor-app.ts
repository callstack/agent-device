import type { DeviceInfo } from '../../kernel/device.ts';
import { AppError, normalizeError } from '../../kernel/errors.ts';
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
    const resolved = await resolveInstalledAppForDoctor(device, targetApp);
    if (!resolved) {
      appendDoctorCheck(checks, {
        id: 'target-app',
        status: 'info',
        summary: `Target app installation checks are not supported for ${device.platform}.`,
        evidence: { requested: targetApp, platform: device.platform },
      });
      return;
    }
    appendDoctorCheck(checks, {
      id: 'target-app',
      status: 'pass',
      summary: `Target app is launchable: ${resolved}`,
      evidence: { requested: targetApp, resolved, sessionApp: session?.appBundleId },
    });
  } catch (error) {
    const normalized = normalizeError(error);
    appendDoctorCheck(checks, {
      id: 'target-app',
      status: 'fail',
      summary: `Target app check failed: ${normalized.message}`,
      hint: normalized.hint ?? 'Install the app or pass an exact package/bundle id or app name.',
      command: `agent-device apps --platform ${device.platform} --all`,
      evidence: { code: normalized.code, message: normalized.message },
    });
  }
}

async function resolveInstalledAppForDoctor(
  device: DeviceInfo,
  targetApp: string,
): Promise<string | undefined> {
  if (device.platform === 'android') {
    const { listAndroidApps } = await import('../../platforms/android/app-lifecycle.ts');
    const apps = await listAndroidApps(device, 'all');
    const match = resolveUniqueInstalledAppMatch(
      targetApp,
      apps.map((app) => ({ id: app.package, name: app.name })),
    );
    return match?.id;
  }
  if (device.platform === 'ios' || device.platform === 'macos') {
    const { listIosApps } = await import('../../platforms/apple/core/apps.ts');
    const apps = await listIosApps(device, 'all');
    const match = resolveUniqueInstalledAppMatch(
      targetApp,
      apps.map((app) => ({ id: app.bundleId, name: app.name })),
    );
    return match?.id;
  }
  return undefined;
}

function resolveUniqueInstalledAppMatch(
  targetApp: string,
  apps: Array<{ id: string; name: string }>,
): { id: string; name: string } | undefined {
  const needle = targetApp.trim().toLowerCase();
  const exact = apps.find(
    (app) => app.id.toLowerCase() === needle || app.name.toLowerCase() === needle,
  );
  if (exact) return exact;

  const matches = apps.filter(
    (app) => app.id.toLowerCase().includes(needle) || app.name.toLowerCase().includes(needle),
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new AppError('AMBIGUOUS_MATCH', `Multiple launchable apps matched "${targetApp}"`, {
      matches: matches.map((app) => app.id),
      hint: 'Pass an exact package/bundle id from agent-device apps --all.',
    });
  }
  throw new AppError('APP_NOT_INSTALLED', `No launchable installed app matched "${targetApp}"`);
}
