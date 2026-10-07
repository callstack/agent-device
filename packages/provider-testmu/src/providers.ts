import { requireEnv } from '@agent-device/provider-webdriver/plugin';
import { canonicalSchemeReference } from '@agent-device/provider-webdriver/providers';

export function requireTestMuCredentials(
  env: Readonly<Record<string, string | undefined>>,
  providerLabel: string,
): { username: string; accessKey: string } {
  return {
    username: requireEnv(env, 'LT_USERNAME', providerLabel),
    accessKey: requireEnv(env, 'LT_ACCESS_KEY', providerLabel),
  };
}

export function isTestMuAppReference(value: string): boolean {
  return /^lt:\/\/[\w.-]+$/.test(value);
}

export function canonicalTestMuAppReference(value: string): string {
  return canonicalSchemeReference(value, 'lt://') ?? value;
}
