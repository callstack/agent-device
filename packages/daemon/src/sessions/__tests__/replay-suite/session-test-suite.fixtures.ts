import type { DaemonResponse, DaemonResponseData } from '@agent-device/kernel/contracts';
import { expect } from 'vitest';
import path from 'node:path';
import { createLiveTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { SessionStore } from '../../../core/session-store.ts';

export function makeSessionStore(): SessionStore {
  const root = mkdtempForTestSync('agent-device-session-test-suite-');
  return new SessionStore(path.join(root, 'sessions'), createLiveTestHostEnvironment());
}

export function expectOkData(response: DaemonResponse | null | undefined): DaemonResponseData {
  expect(response?.ok, JSON.stringify(response)).toBeTruthy();
  if (!response || !response.ok) throw new Error('Expected successful daemon response.');
  return response.data ?? {};
}
