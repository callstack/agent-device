import { canonicalSchemeReference } from '@agent-device/provider-webdriver/providers';

export function isTestMuAppReference(value: string): boolean {
  return /^lt:\/\/[\w.-]+$/.test(value);
}

export function canonicalTestMuAppReference(value: string): string {
  return canonicalSchemeReference(value, 'lt://') ?? value;
}
