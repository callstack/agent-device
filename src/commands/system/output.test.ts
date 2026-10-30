import { expect, test } from 'vitest';
import { systemCliOutputFormatters } from './output.ts';

test('back CLI output renders the settled observation', () => {
  const output = systemCliOutputFormatters.back({
    env: process.env,
    input: {},
    result: {
      action: 'back',
      mode: 'in-app',
      message: 'Back',
      settle: {
        settled: true,
        waitedMs: 300,
        diff: {
          summary: { additions: 1, removals: 2, unchanged: 5 },
          lines: [
            { kind: 'removed', text: '@e9 [button] "Save"' },
            { kind: 'added', text: '@e3 [button] "Edit"', ref: 'e3' },
          ],
        },
      },
    },
  });

  expect(output.text).toBe(
    [
      'Back',
      'settled after 300ms: +1 -2 (~5 unchanged)',
      '- @e9 [button] "Save"',
      '+ @e3 [button] "Edit"',
    ].join('\n'),
  );
});

test('appstate CLI output renders the Apple session app from the runner read', () => {
  const output = systemCliOutputFormatters.appstate({
    env: process.env,
    input: {},
    result: {
      platform: 'ios',
      appName: 'TestApp',
      appBundleId: 'com.example.testapp',
      state: 'runningForeground',
      source: 'runner',
      surface: 'app',
    },
  });
  expect(output.text).toBe(
    [
      'Session app: TestApp',
      'Bundle: com.example.testapp',
      'State: runningForeground',
      'Source: runner',
    ].join('\n'),
  );
});

test('appstate CLI output falls back to the bundle id and omits absent lines', () => {
  const output = systemCliOutputFormatters.appstate({
    env: process.env,
    input: {},
    result: {
      platform: 'ios',
      appBundleId: 'com.example.mobile',
      source: 'session',
      surface: 'app',
    },
  });
  expect(output.text).toBe(
    ['Session app: com.example.mobile', 'Bundle: com.example.mobile', 'Source: session'].join('\n'),
  );
});

test('appstate CLI output renders unknown when the Apple session carries no app identity', () => {
  const output = systemCliOutputFormatters.appstate({
    env: process.env,
    input: {},
    result: { platform: 'ios', surface: 'app' },
  });
  expect(output.text).toBe('Session app: unknown');
});

test('appstate CLI output renders the Android foreground app and activity', () => {
  const output = systemCliOutputFormatters.appstate({
    env: process.env,
    input: {},
    result: {
      platform: 'android',
      package: 'com.example',
      activity: '.MainActivity',
    },
  });
  expect(output.text).toBe(['Foreground app: com.example', 'Activity: .MainActivity'].join('\n'));
});

test('appstate CLI output renders the macOS session app', () => {
  // macOS appState is never admitted by the Apple runtime facts, so the live
  // daemon always answers from the session record: no State line.
  const output = systemCliOutputFormatters.appstate({
    env: process.env,
    input: {},
    result: {
      platform: 'macos',
      appName: 'System Settings',
      appBundleId: 'com.apple.systempreferences',
      source: 'session',
      surface: 'app',
    },
  });
  expect(output.text).toBe(
    ['Session app: System Settings', 'Bundle: com.apple.systempreferences', 'Source: session'].join(
      '\n',
    ),
  );
});

test('appstate CLI output renders the HarmonyOS foreground app and activity', () => {
  const output = systemCliOutputFormatters.appstate({
    env: process.env,
    input: {},
    result: {
      platform: 'harmonyos',
      package: 'com.example.hmapp',
      activity: 'EntryAbility',
    },
  });
  expect(output.text).toBe(
    ['Foreground app: com.example.hmapp', 'Activity: EntryAbility'].join('\n'),
  );
});
