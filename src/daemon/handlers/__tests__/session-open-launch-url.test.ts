import { describe, expect, test } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { setActiveProviderDeviceRuntimes } from '../../../provider-device-runtime.ts';
import {
  makeSession,
  makeSessionStore,
  mockDispatch,
  mockResolveTargetDevice,
  noopInvoke,
} from './session-test-harness.ts';
import { buildSessionOpenLaunchPlan } from '../session-open-launch-url.ts';
import { handleSessionCommands } from '../session.ts';

const iosSimulator = {
  platform: 'apple' as const,
  appleOs: 'ios' as const,
  id: 'sim-1',
  name: 'iPhone 17 Pro',
  kind: 'simulator' as const,
  booted: true,
};

describe('buildSessionOpenLaunchPlan', () => {
  test('folds an iOS launch URL into the app open', () => {
    expect(
      buildSessionOpenLaunchPlan({
        openPositionals: ['com.example.app'],
        runtime: { platform: 'ios', launchUrl: 'myapp://automation' },
        flags: { relaunch: true },
        foldRuntimeLaunchUrl: true,
      }),
    ).toEqual({
      openPositionals: ['com.example.app', 'myapp://automation'],
    });
  });

  test('keeps launch options on the direct app launch before the URL open', () => {
    expect(
      buildSessionOpenLaunchPlan({
        openPositionals: ['com.example.app'],
        runtime: { platform: 'ios', launchUrl: 'myapp://automation' },
        flags: { launchArgs: ['-Flag', 'YES'] },
        foldRuntimeLaunchUrl: true,
      }),
    ).toEqual({
      openPositionals: ['com.example.app'],
      followUpLaunchUrl: 'myapp://automation',
    });
  });

  test('keeps the existing two-dispatch contract when URL folding is unavailable', () => {
    expect(
      buildSessionOpenLaunchPlan({
        openPositionals: ['com.example.app'],
        runtime: { platform: 'ios', launchUrl: 'myapp://automation' },
        flags: {},
        foldRuntimeLaunchUrl: false,
      }),
    ).toEqual({
      openPositionals: ['com.example.app'],
      followUpLaunchUrl: 'myapp://automation',
    });
  });

  test('makes iOS relaunch terminate inside one cold URL launch dispatch', async () => {
    const sessionStore = makeSessionStore();
    const sessionName = 'ios-simulator-runtime-url-relaunch-session';
    sessionStore.set(sessionName, {
      ...makeSession(sessionName, iosSimulator),
      appName: 'com.example.app',
    });
    sessionStore.setRuntimeHints(sessionName, {
      platform: 'ios',
      launchUrl: 'myapp://automation',
    });

    const calls: Array<{ command: string; terminateRunningApp?: boolean }> = [];
    mockResolveTargetDevice.mockResolvedValue(iosSimulator);
    mockDispatch.mockImplementation(async (_device, command, positionals, _out, context) => {
      calls.push({
        command: `${command}:${positionals.join(' ')}`,
        terminateRunningApp: context?.terminateRunningApp,
      });
      return {};
    });

    const response = await handleSessionCommands({
      req: {
        token: 't',
        session: sessionName,
        command: 'open',
        positionals: [],
        flags: { relaunch: true },
      },
      sessionName,
      logPath: path.join(os.tmpdir(), 'daemon.log'),
      sessionStore,
      invoke: noopInvoke,
    });

    expect(response?.ok).toBe(true);
    expect(calls).toEqual([
      {
        command: 'open:com.example.app myapp://automation',
        terminateRunningApp: true,
      },
    ]);
  });

  test('keeps a physical iOS runtime URL as a follow-up open', async () => {
    const sessionStore = makeSessionStore();
    const sessionName = 'ios-device-runtime-url-session';
    const iosDevice = {
      ...iosSimulator,
      id: 'device-1',
      name: 'My iPhone',
      kind: 'device' as const,
    };
    sessionStore.setRuntimeHints(sessionName, {
      platform: 'ios',
      launchUrl: 'https://example.com/automation',
    });

    const calls: string[] = [];
    mockResolveTargetDevice.mockResolvedValue(iosDevice);
    mockDispatch.mockImplementation(async (_device, command, positionals) => {
      calls.push(`${command}:${positionals.join(' ')}`);
      return {};
    });

    const response = await handleSessionCommands({
      req: {
        token: 't',
        session: sessionName,
        command: 'open',
        positionals: ['com.example.app'],
        flags: {},
      },
      sessionName,
      logPath: path.join(os.tmpdir(), 'daemon.log'),
      sessionStore,
      invoke: noopInvoke,
    });

    expect(response).toMatchObject({ ok: true });
    expect(calls).toEqual(['open:com.example.app', 'open:https://example.com/automation']);
  });

  test('keeps a provider iOS simulator runtime URL as a follow-up open', async () => {
    const sessionStore = makeSessionStore();
    const sessionName = 'provider-ios-runtime-url-session';
    const providerSimulator = {
      ...iosSimulator,
      id: 'provider:ios:lease-a',
      name: 'Provider iPhone',
    };
    sessionStore.setRuntimeHints(sessionName, {
      platform: 'ios',
      launchUrl: 'myapp://automation',
    });
    setActiveProviderDeviceRuntimes([
      {
        provider: 'fake-provider',
        leaseLifecycle: {},
        deviceInventoryProvider: async () => [providerSimulator],
        ownsDevice: (candidate) => candidate.id === providerSimulator.id,
        getInteractor: () => undefined,
        shutdown: async () => {},
      },
    ]);

    const calls: string[] = [];
    mockResolveTargetDevice.mockResolvedValue(providerSimulator);
    mockDispatch.mockImplementation(async (_device, command, positionals) => {
      calls.push(`${command}:${positionals.join(' ')}`);
      return {};
    });

    try {
      const response = await handleSessionCommands({
        req: {
          token: 't',
          session: sessionName,
          command: 'open',
          positionals: ['com.example.app'],
          flags: {},
        },
        sessionName,
        logPath: path.join(os.tmpdir(), 'daemon.log'),
        sessionStore,
        invoke: noopInvoke,
      });

      expect(response).toMatchObject({ ok: true });
      expect(calls).toEqual(['open:com.example.app', 'open:myapp://automation']);
    } finally {
      setActiveProviderDeviceRuntimes([]);
    }
  });
});
