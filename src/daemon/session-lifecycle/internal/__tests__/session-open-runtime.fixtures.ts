import path from 'node:path';
import { SessionStore } from '../../../session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../../../types.ts';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';

export const noopInvoke = async (_req: DaemonRequest): Promise<DaemonResponse> => ({
  ok: true,
  data: {},
});

export function makeSessionStore(): SessionStore {
  const root = mkdtempForTestSync('agent-device-session-open-runtime-');
  return new SessionStore(path.join(root, 'sessions'));
}

export function makeSession(name: string, device: SessionState['device']): SessionState {
  return {
    name,
    device,
    createdAt: Date.now(),
    actions: [],
  };
}

export function makeAndroidEmulator(id = 'emulator-5554') {
  return {
    platform: 'android' as const,
    id,
    name: 'Pixel',
    kind: 'emulator' as const,
    booted: true,
  };
}

export function makeAppleSimulator(id = 'sim-1') {
  return {
    platform: 'apple' as const,
    id,
    name: 'iPhone 17 Pro',
    kind: 'simulator' as const,
    booted: true,
  };
}

export function makeAndroidDevice(id = 'R5CN30') {
  return {
    platform: 'android' as const,
    id,
    name: 'Galaxy',
    kind: 'device' as const,
    booted: true,
  };
}
