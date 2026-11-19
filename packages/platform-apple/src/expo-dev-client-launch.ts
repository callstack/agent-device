import type { DeviceInfo } from '@agent-device/kernel/device';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import type { OpenApplicationInput } from '@agent-device/contracts/application-lifecycle-runtime';
import { resolveRuntimeServerUrl } from '@agent-device/host-kit/runtime-transport-hints';
import { resolveIosSimulatorExpoDevClientScheme } from './core/app-resolution.ts';

/** Detection must stay well inside the 20 s `simctl openurl` bound of the launch it precedes. */
const EXPO_DEV_CLIENT_PROBE_TIMEOUT_MS = 3_000;

/** Resolves automatic Expo launch; explicit URLs or inconclusive detection keep normal launch. */
export async function resolveExpoDevClientLaunchUrl(
  device: DeviceInfo,
  input: OpenApplicationInput,
): Promise<string | undefined> {
  if (!input.appBundleId || input.runtimeLaunchUrl?.trim()) return undefined;
  const values = input.runtimeHints?.values;
  const serverUrl = resolveRuntimeServerUrl({
    metroHost: values?.metroHost,
    metroPort: values?.metroPort ? Number(values.metroPort) : undefined,
    bundleUrl: values?.bundleUrl,
  });
  if (!serverUrl) return undefined;
  let scheme: string | undefined;
  try {
    scheme = await resolveIosSimulatorExpoDevClientScheme(device, input.appBundleId, {
      timeoutMs: EXPO_DEV_CLIENT_PROBE_TIMEOUT_MS,
    });
  } catch (error) {
    if (isRequestCanceledError(error)) throw error;
    return undefined;
  }
  return scheme
    ? `${scheme}://expo-development-client/?url=${encodeURIComponent(serverUrl.toString().replace(/\/+$/, ''))}`
    : undefined;
}
