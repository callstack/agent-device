import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { buildIosOpenCommandHint } from './ios-app-session-hint.ts';
import { isIosSimulator } from './device-targets.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from './types.ts';
import { errorResponse } from './handlers/response.ts';

/** Legacy diff-only policy retained until that descriptor receives its own runtime cutover. */
export function requireLegacyDiffCustomActionsSupported(
  req: DaemonRequest,
  device: DeviceInfo,
): DaemonResponse | null {
  if (req.flags?.snapshotCustomActions !== true || isIosSimulator(device)) return null;
  return errorResponse(
    'UNSUPPORTED_OPERATION',
    `--actions requires an iOS simulator: custom actions are read through the private accessibility snapshot backend, which ${device.platform}/${device.kind} targets do not have.`,
    { hint: 'Re-run without --actions, or target an iOS simulator.' },
  );
}

export async function requireLegacyDiffIosAppSession(params: {
  session: SessionState | undefined;
  device: SessionState['device'];
  providerOwned: boolean;
}): Promise<DaemonResponse | null> {
  const { session, device, providerOwned } = params;
  if (!isIosFamily(device) || session?.appBundleId || providerOwned) return null;
  const openCommandHint = await buildIosOpenCommandHint(device);
  return errorResponse(
    'SESSION_NOT_FOUND',
    `iOS diff requires an active app session on the target device. Run open first (for example: open --session ${session?.name ?? 'sim'} --platform ios --device "<name>" <app>).`,
    {
      reason: 'ios_app_session_required',
      ...(openCommandHint ? { hint: openCommandHint } : {}),
    },
  );
}
