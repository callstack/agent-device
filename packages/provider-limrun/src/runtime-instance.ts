import { providerRuntimeInstance } from '@agent-device/contracts/platform-runtime';
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

/** Read the names from the same operator setting the SDK reads at construction. */
export function limrunCustomHeaderNames(config: string | undefined): string[] {
  const names = new Set<string>();
  for (const line of config?.split('\n') ?? []) {
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    if (name && name !== 'authorization') names.add(name);
  }
  return [...names].sort();
}

export function resolveLimrunRentalRecoveryPrincipal(
  baseUrl: string,
  headers: Headers,
  customHeaderNames: readonly string[],
): string | undefined {
  const authorization = headers.get('authorization');
  if (!authorization) return undefined;
  return providerRuntimeInstance('limrun', [
    ['authorization', authorization],
    ['baseUrl', baseUrl],
    [
      'customHeaders',
      customHeaderNames.length === 0
        ? undefined
        : JSON.stringify(customHeaderNames.map((name) => [name, headers.get(name)])),
    ],
  ]);
}
