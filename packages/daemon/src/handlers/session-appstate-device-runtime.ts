import { appStateUse } from '@agent-device/contracts/platform-runtime-operations';
import {
  isIosFamily,
  isMacOs,
  publicPlatformString,
  type DeviceInfo,
} from '@agent-device/kernel/device';
import { resolveAndroidSerialAllowlist } from '@agent-device/kernel/device-isolation';
import { admitRuntimeUse } from '../runtime-admission.ts';
import type { RuntimeCommandHandlerParams } from '../session-runtime-admission.ts';
import type { DaemonResponse } from '../daemon-request.ts';
import { appleSessionRequiredRefusal } from './session-appstate-apple-session.ts';

function sortedAndroidSerialAllowlist(value: string | undefined): string[] | undefined {
  const allowlist = resolveAndroidSerialAllowlist(value);
  return allowlist ? [...allowlist].sort() : undefined;
}

/**
 * The foreground app a device runtime reports for a non-session target. Apple devices never
 * answer here — they require the session the runner is attached to — so only runtimes whose owner
 * admits `appState` (the local Android and HarmonyOS runtimes on devices and emulators, and the
 * Limrun Android runtime today) get their readiness warmed and queried.
 */
export async function queryDeviceRuntimeAppState(
  params: RuntimeCommandHandlerParams,
  device: DeviceInfo,
): Promise<DaemonResponse> {
  if (isIosFamily(device)) return appleSessionRequiredRefusal('ios');
  if (isMacOs(device)) return appleSessionRequiredRefusal('macos');
  const flags = params.req.flags ?? {};
  const admitted = await admitRuntimeUse({
    command: 'appstate',
    device,
    use: appStateUse,
    inspectFacts: params.inspectFacts,
    platformServices: params.platformServices,
    bindDevice: params.bindDevice,
  });
  if (admitted.type === 'response') return admitted.response;
  const runtime = admitted.runtime;
  await runtime.operations.ensureReady({
    serial: flags.serial,
    androidSerialAllowlist: sortedAndroidSerialAllowlist(flags.androidDeviceAllowlist),
  });
  const state = await runtime.operations.appState();
  return {
    ok: true,
    data: {
      platform: publicPlatformString(device),
      package: state.package,
      activity: state.activity,
    },
  };
}
