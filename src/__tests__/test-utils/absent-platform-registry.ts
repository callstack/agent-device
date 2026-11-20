import type { ProviderRegistry } from '@agent-device/plugins/registry';

export const absentPlatformRegistry: Pick<ProviderRegistry, 'platforms' | 'resolvePlatform'> = {
  platforms: [],
  resolvePlatform: (family, reportAbsent) => {
    throw reportAbsent(family);
  },
};
