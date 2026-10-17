import * as devServer from '@agent-device/react-native';
import { withCommandHost } from '@agent-device/host-kit/command';
import { captureHostEnvironment } from '@agent-device/host-kit/process';

export {
  normalizeBaseUrl,
  buildBundleUrl,
  resolveRuntimeTransport,
  type MetroBridgeDescriptor,
  type MetroTunnelRequestMessage,
  type MetroTunnelResponseMessage,
} from '@agent-device/react-native';

// A JS host calls these without a daemon or CLI around it, so each call runs as a command host
// that reads the process's current environment, as these functions always have.
async function inProcessHost<T>(fn: () => Promise<T>): Promise<T> {
  return await withCommandHost(
    { host: captureHostEnvironment(process), requestEnv: undefined },
    fn,
  );
}

export const prepareMetroRuntime: typeof devServer.prepareMetroRuntime = async (input) =>
  await inProcessHost(() => devServer.prepareMetroRuntime(input));

export const reloadMetro: typeof devServer.reloadMetro = async (input) =>
  await inProcessHost(() => devServer.reloadMetro(input));

export const stopMetroTunnel: typeof devServer.stopMetroTunnel = async (options) =>
  await inProcessHost(() => devServer.stopMetroTunnel(options));
