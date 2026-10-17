import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { RuntimeFacts } from '@agent-device/contracts/platform-runtime';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
  PlatformRuntimeProviderModule,
} from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createComposedPlatformRuntimeGateway } from '../../../src/platform-runtime-gateway.ts';

export async function inspectProviderDeploymentAdmission(params: {
  runtime: ProviderDeviceRuntime;
  module: PlatformRuntimeProviderModule;
  device: DeviceInfo;
}): Promise<RuntimeFacts<PlatformRuntimeOperations>> {
  const localLoadCalls: string[] = [];
  const gateway = createComposedPlatformRuntimeGateway({
    modules: new Map([
      [
        'android',
        {
          family: 'android',
          loadRuntime: async () => {
            localLoadCalls.push('android');
            throw new Error('provider-owned device must not load a local runtime');
          },
        },
      ],
    ]),
    loadHost: async () => ({}) as PlatformRuntimeHost,
    providerRuntimes: [params.runtime],
    providerModules: [{ runtime: params.runtime, module: params.module }],
  });

  try {
    const facts = await gateway.inspectFacts(params.device);
    if (localLoadCalls.length > 0) {
      throw new Error('provider-owned facts inspection loaded a local runtime');
    }
    return facts;
  } finally {
    await gateway.shutdown();
  }
}
