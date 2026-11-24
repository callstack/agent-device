import { providerRuntimeInstance } from '@agent-device/contracts/platform-runtime';
import type Limrun from '@limrun/api';
import type { LimrunIosModel } from './device.ts';
import type { LimrunInstanceAccess } from './instance-access.ts';

/**
 * The runtime-owner instance for one Limrun account: the explicit identity when the composition
 * names one, otherwise the fingerprint of the facts that decide which devices this runtime rents.
 */
export function resolveLimrunRuntimeInstance(options: {
  apiKey?: string;
  region?: string;
  iosModel?: LimrunIosModel;
  runtimeInstance?: string;
  instances?: LimrunInstanceAccess;
}): string {
  if (options.runtimeInstance !== undefined) {
    const explicit = options.runtimeInstance.trim();
    if (!explicit) throw new TypeError('Limrun runtimeInstance must be a non-empty string');
    return explicit;
  }
  return providerRuntimeInstance('limrun', [
    ['region', options.region?.trim().toLowerCase() || 'default'],
    ['apiKey', options.apiKey],
    ['iosModel', options.instances?.ios ? undefined : options.iosModel],
    ['attachedIos', options.instances?.ios?.apiUrl],
    ['attachedAndroid', options.instances?.android?.apiUrl],
  ]);
}

export async function resolveLimrunRentalRecoveryPrincipal(
  client: Limrun,
): Promise<string | undefined> {
  // The SDK retains its constructor-resolved overrides here, including those from its environment.
  // If a future SDK no longer exposes this shape, the runtime cannot prove its recovery scope.
  const { isRecord } = await import('@agent-device/kernel/record');
  const options: unknown = Reflect.get(client, '_options');
  if (!isRecord(options)) return undefined;
  const defaults = options.defaultHeaders;
  if (defaults !== undefined && !isRecord(defaults)) return undefined;
  const customHeaderNames = [
    ...new Set(Object.keys(defaults ?? {}).map((name) => name.toLowerCase())),
  ]
    .filter((name) => name !== 'authorization')
    .sort();
  const {
    req: { headers },
  } = await client.buildRequest({ method: 'get', path: '/' });
  const authorization = headers.get('authorization');
  if (!authorization) return undefined;
  return providerRuntimeInstance('limrun', [
    ['authorization', authorization],
    ['baseUrl', client.baseURL],
    [
      'customHeaders',
      customHeaderNames.length === 0
        ? undefined
        : JSON.stringify(customHeaderNames.map((name) => [name, headers.get(name)])),
    ],
  ]);
}
