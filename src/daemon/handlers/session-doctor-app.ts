import { publicPlatformString, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import type { SessionState } from '../types.ts';
import { appendDoctorCheck } from './session-doctor-output.ts';
import type { DoctorCheck } from '@agent-device/contracts/observability';
import type { InstalledAppInfo } from '@agent-device/contracts/platform';

export type DoctorAppInventory = (
  filter: 'all' | 'user-installed',
) => Promise<readonly InstalledAppInfo[]>;

export async function appendAppChecks(
  checks: DoctorCheck[],
  params: {
    device: DeviceInfo;
    session: SessionState | undefined;
    targetApp?: string;
    listInstalledApps?: DoctorAppInventory;
  },
): Promise<void> {
  const { device, targetApp, session, listInstalledApps } = params;
  if (!targetApp) {
    return;
  }

  try {
    const resolved = listInstalledApps
      ? resolveUniqueInstalledAppMatch(targetApp, await listInstalledApps('all'))?.id
      : undefined;
    if (!resolved) {
      appendDoctorCheck(checks, {
        id: 'target-app',
        status: 'info',
        // approach (b): emit the PUBLIC leaf platform (ios/macos), never the internal `apple`.
        summary: `Target app installation checks are not supported for ${publicPlatformString(device)}.`,
        evidence: { requested: targetApp, platform: publicPlatformString(device) },
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
      command: `agent-device apps --platform ${publicPlatformString(device)} --all`,
      evidence: { code: normalized.code, message: normalized.message },
    });
  }
}

function resolveUniqueInstalledAppMatch(
  targetApp: string,
  apps: readonly InstalledAppInfo[],
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
