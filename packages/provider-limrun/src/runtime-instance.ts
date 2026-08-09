import { createHash } from 'node:crypto';

export function resolveLimrunRuntimeInstance(options: {
  apiKey: string;
  region?: string;
  runtimeInstance?: string;
}): string {
  if (options.runtimeInstance !== undefined) {
    const explicit = options.runtimeInstance.trim();
    if (!explicit) throw new TypeError('Limrun runtimeInstance must be a non-empty string');
    return explicit;
  }
  const principal = JSON.stringify({
    provider: 'limrun',
    region: options.region?.trim().toLowerCase() || 'default',
    apiKey: options.apiKey,
  });
  return `principal-${createHash('sha256').update(principal).digest('hex')}`;
}
