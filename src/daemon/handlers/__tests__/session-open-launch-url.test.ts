import { describe, expect, test } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
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
        device: iosSimulator,
        openPositionals: ['com.example.app'],
        runtime: { platform: 'ios', launchUrl: 'myapp://automation' },
        flags: { relaunch: true },
      }),
    ).toEqual({
      openPositionals: ['com.example.app', 'myapp://automation'],
      supportsTerminateRunningApp: true,
    });
  });

  test('keeps launch options on the direct app launch before the URL open', () => {
    expect(
      buildSessionOpenLaunchPlan({
        device: iosSimulator,
        openPositionals: ['com.example.app'],
        runtime: { platform: 'ios', launchUrl: 'myapp://automation' },
        flags: { launchArgs: ['-Flag', 'YES'] },
      }),
    ).toEqual({
      openPositionals: ['com.example.app'],
      followUpLaunchUrl: 'myapp://automation',
      supportsTerminateRunningApp: true,
    });
  });

  test('keeps the existing two-dispatch contract off Apple platforms', () => {
    expect(
      buildSessionOpenLaunchPlan({
        device: {
          platform: 'android',
          id: 'emulator-5554',
          name: 'Pixel',
          kind: 'emulator',
          booted: true,
        },
        openPositionals: ['com.example.app'],
        runtime: { platform: 'android', launchUrl: 'myapp://automation' },
        flags: {},
      }),
    ).toEqual({
      openPositionals: ['com.example.app'],
      followUpLaunchUrl: 'myapp://automation',
      supportsTerminateRunningApp: true,
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
});
