import { appStateUse } from '@agent-device/contracts/platform-runtime-operations';
import {
  isIosFamily,
  isMacOs,
  publicPlatformString,
  type DeviceInfo,
} from '@agent-device/kernel/device';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { resolveAndroidSerialAllowlist } from '@agent-device/kernel/device-isolation';
import { admitRuntimeUse } from '../../core/runtime-admission.ts';
import type { RuntimeCommandHandlerParams } from '../../core/session-runtime-admission.ts';
import {
  appStateSessionNotFoundResponse,
  appleSessionRequiredRefusal,
} from './session-appstate-apple-session.ts';

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
  namedSessionMissing: boolean,
): Promise<DaemonResponse> {
  if (isIosFamily(device) || isMacOs(device)) {
    // The admission-time fact (see AppStateTargetDecision): resolution already succeeded, so the
    // only question left is whether this request was admitted without the session it names. A
    // request that named no session keeps the plain session-required refusal.
    if (namedSessionMissing) {
      return appStateSessionNotFoundResponse(params.sessionName, device.platform);
    }
    return appleSessionRequiredRefusal(isMacOs(device) ? 'macos' : 'ios');
  }
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
