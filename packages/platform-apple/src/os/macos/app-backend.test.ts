import { bindTestCommandHost } from '@agent-device/test-kit';
import { afterEach, expect, test, vi } from 'vitest';
import { hostMacOsAppBackend } from './app-backend.ts';

bindTestCommandHost();

afterEach(() => {
  vi.unstubAllEnvs();
});

test('the host keeps XCTest for app sessions unless it opts into the native backend', () => {
  vi.stubEnv('AGENT_DEVICE_MACOS_APP_BACKEND', '');
  expect(hostMacOsAppBackend(process.env)).toBe('xctest');
  vi.stubEnv('AGENT_DEVICE_MACOS_APP_BACKEND', 'native');
  expect(hostMacOsAppBackend(process.env)).toBe('native');
});
