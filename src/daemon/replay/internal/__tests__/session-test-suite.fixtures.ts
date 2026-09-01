import { expect } from 'vitest';
import path from 'node:path';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';
import { SessionStore } from '../../../session-store.ts';
import type { DaemonResponse, DaemonResponseData } from '../../../types.ts';

export function makeSessionStore(): SessionStore {
  const root = mkdtempForTestSync('agent-device-session-test-suite-');
  return new SessionStore(path.join(root, 'sessions'));
}

export function expectOkData(response: DaemonResponse | null | undefined): DaemonResponseData {
  expect(response?.ok, JSON.stringify(response)).toBeTruthy();
  if (!response || !response.ok) throw new Error('Expected successful daemon response.');
  return response.data ?? {};
}
