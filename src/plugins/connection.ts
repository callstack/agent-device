import type { CliFlags } from '@agent-device/contracts/command';
import type { ProviderConnectionVerification } from '@agent-device/contracts/remote';
import type { EnvMap } from '@agent-device/kernel/source-value';
import type { RemoteConfigProfile } from '../remote/remote-config-schema.ts';
import type { ConnectionProviderCapabilities } from '@agent-device/contracts/remote';
import { installedPlugins } from './store.ts';

export type PluginConnection = Readonly<{
  resolve(context: { flags: CliFlags; stateDir: string; cwd: string; env: EnvMap }):
    | Promise<{
        profile: RemoteConfigProfile;
        extraFlags?: Partial<CliFlags>;
      }>
    | { profile: RemoteConfigProfile; extraFlags?: Partial<CliFlags> };
  verify(context: { flags: CliFlags; env: EnvMap }): Promise<ProviderConnectionVerification>;
}>;

export function pluginConnectionCapabilities(
  provider: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ConnectionProviderCapabilities | undefined {
  return provider === undefined
    ? undefined
    : installedPlugins(env).find((plugin) => plugin.agentDevicePlugin.provider === provider)
        ?.agentDevicePlugin.connection;
}

export function pluginConnectionNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return installedPlugins(env)
    .filter((plugin) => plugin.agentDevicePlugin.connection)
    .map((plugin) => plugin.agentDevicePlugin.provider);
}
