import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { AgentDeviceClientConfig } from '@agent-device/contracts/client';
import type { AgentDeviceClient } from '../client/client-types.ts';
import type { AgentDevicePlugin } from '@agent-device/plugins/contract';
import type { ShutdownReport } from '@agent-device/daemon';

export type StartAgentDeviceOptions = Readonly<{
  /** Required state directory to own, resolved against the host working directory. */
  stateDir: string;
  /** The environment and working directory to run with. Defaults to one captured copy of this process's. */
  host?: HostEnvironment;
  /** Imported plugins to register after the built-ins. The plugin store is not read. */
  plugins?: readonly AgentDevicePlugin[];
}>;

export type AgentDeviceHost = Readonly<{
  /** A client pinned to this instance. */
  client: AgentDeviceClient;
  /** Serializable attach config containing this instance's bearer token. Keep it inside the host. */
  clientConfig: AgentDeviceClientConfig;
  /** Reports unfinished teardown. Repeated calls share one close; never exits the process. */
  close: () => Promise<ShutdownReport>;
}>;
