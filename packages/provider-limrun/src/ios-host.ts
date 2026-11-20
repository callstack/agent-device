import type { ProviderPluginHost } from 'agent-device/plugins';
import type {
  ProviderAppleHost,
  ProviderHostCapabilities,
  ProviderHostKit,
} from 'agent-device/plugins/device-host';

/**
 * What the lease's XCTest runner asks of the host it is set up on. The shared Apple runner, its
 * tool-provider scope and the host's own retry and archive mechanics stay with the host; this
 * provider supplies the simulator they reach.
 */
export type LimrunIosHost = Readonly<{
  apple: ProviderAppleHost;
  kit: ProviderHostKit;
  env: ProviderPluginHost['env'];
  clientVersion: string;
  emitDiagnostic: ProviderHostCapabilities['emitDiagnostic'];
}>;
