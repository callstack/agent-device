import type { DeviceTarget, PlatformSelector } from '@agent-device/kernel/device';

export type ReplayScriptMetadata = {
  platform?: Exclude<PlatformSelector, 'web'>;
  target?: DeviceTarget;
  timeoutMs?: number;
  retries?: number;
  env?: Record<string, string>;
};

export type ReplayVarSources = {
  builtins?: Record<string, string>;
  fileEnv?: Record<string, string>;
  shellEnv?: Record<string, string>;
  cliEnv?: Record<string, string>;
};
