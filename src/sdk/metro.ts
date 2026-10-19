import * as devServer from '@agent-device/react-native';
import { captureSdkHost } from './host.ts';

export {
  normalizeBaseUrl,
  buildBundleUrl,
  resolveRuntimeTransport,
  reloadMetro,
  stopMetroTunnel,
  type MetroBridgeDescriptor,
  type MetroTunnelRequestMessage,
  type MetroTunnelResponseMessage,
} from '@agent-device/react-native';

/** A JS host calls this with no daemon or CLI around it, so it reads the process's current environment. */
export async function prepareMetroRuntime(
  input: Parameters<typeof devServer.prepareMetroRuntime>[0] = {},
): ReturnType<typeof devServer.prepareMetroRuntime> {
  return await devServer.prepareMetroRuntime(input, captureSdkHost());
}
