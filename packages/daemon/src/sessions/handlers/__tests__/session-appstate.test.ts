import { daemonPlatformServicesFixture } from '../../../__tests__/support/platform-services-fixture.ts';
import { test, expect, vi } from 'vitest';
import { makeSessionStore } from '../../../__tests__/support/handlers/session-test-harness.ts';
import { handleAppStateCommand } from '../session-appstate.ts';
import { PRE_DISPATCH_REFUSAL_REASONS } from '@agent-device/kernel/errors';
import { resolveTargetDevice } from '@agent-device/device-selection/dispatch-resolve';
import { createUnavailableRuntimeFactsForTest } from '@agent-device/test-kit';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DaemonRequest } from '../../../core/daemon-request.ts';

function appStateRequest(session: string, flags: DaemonRequest['flags']): DaemonRequest {
  return { token: 't', session, command: 'appstate', positionals: [], flags };
}

test('appstate returns missing-session error for explicit session flag', async () => {
  const response = await handleAppStateCommand({
    platformServices: daemonPlatformServicesFixture(),
    req: appStateRequest('named', { platform: 'ios', session: 'named' }),
    sessionName: 'named',
    sessionStore: makeSessionStore(),
  });

  expect(response).toBeTruthy();
  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.code).toBe('SESSION_NOT_FOUND');
    expect(response.error.message).toMatch(/Run open with --session named first/i);
    // The same typed refusal every named-session seam answers with (#3674).
    expect(response.error.details?.reason).toBe(PRE_DISPATCH_REFUSAL_REASONS.namedSessionNotFound);
    expect(response.error.details?.dispatched).toBe('no');
    expect(response.error.details?.session).toBe('named');
  }
});

test('appstate --platform macos missing-session error never suggests omitting --session', async () => {
  const response = await handleAppStateCommand({
    platformServices: daemonPlatformServicesFixture(),
    req: appStateRequest('named', { platform: 'macos', session: 'named' }),
    sessionName: 'named',
    sessionStore: makeSessionStore(),
  });

  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.code).toBe('SESSION_NOT_FOUND');
    // macOS appstate is session-required just like iOS, so pointing at
    // "omit --session" would only lead to the session-required refusal.
    expect(response.error.message).toMatch(/Run open with --session named first/i);
    expect(response.error.message).not.toMatch(/omit --session/i);
  }
});

test('appstate --platform apple missing-session error never suggests omitting --session', async () => {
  const response = await handleAppStateCommand({
    platformServices: daemonPlatformServicesFixture(),
    req: appStateRequest('named', { platform: 'apple', session: 'named' }),
    sessionName: 'named',
    sessionStore: makeSessionStore(),
  });

  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.code).toBe('SESSION_NOT_FOUND');
    // The `apple` family selector reaches the same session-required refusal one
    // step later, so the hint must send it straight to opening the session.
    expect(response.error.message).toMatch(/Run open with --session named first/i);
    expect(response.error.message).not.toMatch(/omit --session/i);
  }
});

test('appstate --udid with no --platform resolves the stated device and THEN answers the typed reason', async () => {
  // `--udid` is the Apple identity flag, so a bare `--udid <ios>` reaches the device-runtime lane
  // and lands on an Apple device, which answers the typed reason the commands.md row promises
  // "even with an explicit device". The pin is resolution-first: the route must prove the stated
  // target before refusing it, so a resolution call on that exact device is required here.
  const iosSim: DeviceInfo = {
    platform: 'apple',
    appleOs: 'ios',
    id: 'SIM-UDID-A',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    target: 'mobile',
    booted: true,
  };
  const resolved = vi.mocked(resolveTargetDevice);
  resolved.mockReset();
  resolved.mockResolvedValue(iosSim);
  const inspected: string[] = [];
  try {
    const response = await handleAppStateCommand({
      platformServices: daemonPlatformServicesFixture(),
      req: appStateRequest('lost', { session: 'lost', udid: 'SIM-UDID-A' }),
      sessionName: 'lost',
      sessionStore: makeSessionStore(),
      inspectFacts: async (inspectedDevice) => {
        inspected.push(inspectedDevice.id);
        return createUnavailableRuntimeFactsForTest(inspectedDevice, localRuntimeOwner('apple'), {
          available: false,
          reason: 'owner-capability-missing',
        });
      },
    });

    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe('SESSION_NOT_FOUND');
    expect(response.error.details?.reason).toBe(PRE_DISPATCH_REFUSAL_REASONS.namedSessionNotFound);
    expect(response.error.details?.session).toBe('lost');
    // Resolution ran, once, on the identity the request stated — the refusal is the device
    // runtime lane's, after the target was proven, not a guard that skipped the stated device.
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(resolved).toHaveBeenCalledWith(
      expect.objectContaining({ udid: 'SIM-UDID-A' }),
      expect.anything(),
    );
    expect(inspected).toEqual([]);
  } finally {
    resolved.mockReset();
  }
});

test('appstate --udid on an Apple device without naming a session keeps the plain session-required advice', async () => {
  // The typed named-session reason belongs to requests that named a session this daemon does not
  // hold. A request that named none (only the implicit default) gets the plain advice to run
  // open — the device-runtime arm must not type a reason it has no session for.
  const iosSim: DeviceInfo = {
    platform: 'apple',
    appleOs: 'ios',
    id: 'SIM-UDID-B',
    name: 'iPhone 16',
    kind: 'simulator',
    target: 'mobile',
    booted: true,
  };
  const resolved = vi.mocked(resolveTargetDevice);
  resolved.mockReset();
  resolved.mockResolvedValue(iosSim);
  try {
    const response = await handleAppStateCommand({
      platformServices: daemonPlatformServicesFixture(),
      req: appStateRequest('default', { udid: 'SIM-UDID-B' }),
      sessionName: 'default',
      sessionStore: makeSessionStore(),
      inspectFacts: async (inspectedDevice) =>
        createUnavailableRuntimeFactsForTest(inspectedDevice, localRuntimeOwner('apple'), {
          available: false,
          reason: 'owner-capability-missing',
        }),
    });

    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe('SESSION_NOT_FOUND');
    expect(response.error.message).toMatch(/iOS appstate requires an active session/i);
    expect(response.error.details?.reason).toBeUndefined();
    // Resolution-first holds for the plain advice too: the stated UDID is proven before the
    // refusal, so an implementation that skipped resolving an invalid UDID fails here.
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(resolved).toHaveBeenCalledWith(
      expect.objectContaining({ udid: 'SIM-UDID-B' }),
      expect.anything(),
    );
  } finally {
    resolved.mockReset();
  }
});

test('appstate keeps the admission-time named-session verdict when the store changes during resolution', async () => {
  // The error family is decided once, at admission. If another caller recreates the session
  // while this request is resolving its device, the Apple refusal this request was admitted into
  // stays the typed named-session one — a mid-await store change must not silently switch the
  // request into a different family (nor answer from a session it never admitted).
  const iosSim: DeviceInfo = {
    platform: 'apple',
    appleOs: 'ios',
    id: 'SIM-UDID-C',
    name: 'iPhone Air',
    kind: 'simulator',
    target: 'mobile',
    booted: true,
  };
  const sessionStore = makeSessionStore();
  const resolved = vi.mocked(resolveTargetDevice);
  resolved.mockReset();
  resolved.mockImplementation(async () => {
    // The concurrent store change, planted mid-await exactly where a re-read would disagree.
    sessionStore.publish('lost', {
      name: 'lost',
      device: iosSim,
      createdAt: 1,
      actions: [],
    });
    return iosSim;
  });
  try {
    const response = await handleAppStateCommand({
      platformServices: daemonPlatformServicesFixture(),
      req: appStateRequest('lost', { session: 'lost', udid: 'SIM-UDID-C' }),
      sessionName: 'lost',
      sessionStore,
    });

    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.details?.reason).toBe(PRE_DISPATCH_REFUSAL_REASONS.namedSessionNotFound);
    expect(response.error.details?.session).toBe('lost');
  } finally {
    resolved.mockReset();
  }
});

test('appstate with a named session and an identity device selector keeps the stated target', async () => {
  // Same priority as the resolution guard (#3674): the request names a session this daemon lost
  // but states a concrete device, so it is not answered on the missing session. It resolves the
  // stated device and reaches that device's own runtime admission — proven by the resolution and
  // fact inspection naming emulator-5554 — and any refusal is the device's, never the named one.
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel 9',
    kind: 'emulator',
    target: 'mobile',
    booted: true,
  };
  // This file's harness stubs device resolution; this test drives that stub and asserts the
  // request's stated identity reaches it.
  const resolved = vi.mocked(resolveTargetDevice).mockResolvedValue(device);
  const inspected: string[] = [];
  try {
    const response = await handleAppStateCommand({
      platformServices: daemonPlatformServicesFixture(),
      req: appStateRequest('named', { session: 'named', platform: 'android', device: 'Pixel 9' }),
      sessionName: 'named',
      sessionStore: makeSessionStore(),
      inspectFacts: async (inspectedDevice) => {
        inspected.push(inspectedDevice.id);
        return createUnavailableRuntimeFactsForTest(inspectedDevice, localRuntimeOwner('android'), {
          available: false,
          reason: 'owner-capability-missing',
        });
      },
    });

    expect(resolved).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'android', device: 'Pixel 9' }),
      expect.anything(),
    );
    expect(inspected).toEqual(['emulator-5554']);
    if (!response.ok) {
      expect(response.error.details?.reason).not.toBe(
        PRE_DISPATCH_REFUSAL_REASONS.namedSessionNotFound,
      );
    }
  } finally {
    resolved.mockReset();
  }
});

test('appstate refuses --platform ios without a session at the message level', async () => {
  const response = await handleAppStateCommand({
    platformServices: daemonPlatformServicesFixture(),
    req: appStateRequest('default', { platform: 'ios', device: 'iPhone 17' }),
    sessionName: 'default',
    sessionStore: makeSessionStore(),
  });

  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.code).toBe('SESSION_NOT_FOUND');
    expect(response.error.message).toBe(
      'iOS appstate requires an active session on the target device. Run open first (for example: open --session sim --platform ios --device "<name>" <app>).',
    );
  }
});

test('appstate refuses --platform macos without a session at the message level', async () => {
  const response = await handleAppStateCommand({
    platformServices: daemonPlatformServicesFixture(),
    req: appStateRequest('default', { platform: 'macos', device: 'Mac' }),
    sessionName: 'default',
    sessionStore: makeSessionStore(),
  });

  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.code).toBe('SESSION_NOT_FOUND');
    expect(response.error.message).toBe(
      'macOS appstate requires an active session on the target device. Run open first (for example: open --session macos --platform macos "System Settings").',
    );
  }
});
