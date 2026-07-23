import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildActionEventResult } from '../session-event-action-presentation.ts';
import { buildActionDetails, buildActionSummary } from '../session-event-action.ts';
import type { SessionAction } from '../types.ts';

function action(
  command: string,
  result: Record<string, unknown>,
  overrides: Partial<SessionAction> = {},
): SessionAction {
  return {
    ts: Date.now(),
    command,
    positionals: [],
    flags: {},
    result,
    ...overrides,
  };
}

test('scroll action events describe direction and distance', () => {
  const byPixels = action('scroll', {
    direction: 'down',
    pixels: 240,
    durationMs: 500,
  });
  const toEdge = action('scroll', {
    direction: 'up',
    edge: 'top',
    passes: 3,
  });
  const byAmount = action('scroll', {
    direction: 'right',
    amount: 0.6,
  });

  assert.equal(buildActionSummary(byPixels), 'Scrolled down by 240px');
  assert.equal(buildActionSummary(toEdge), 'Scrolled to top in 3 passes');
  assert.equal(buildActionSummary(byAmount), 'Scrolled right by 0.6');
  const details = buildActionDetails(byPixels);
  assert.deepEqual(
    {
      direction: details.direction,
      pixels: details.pixels,
      durationMs: details.durationMs,
    },
    {
      direction: 'down',
      pixels: 240,
      durationMs: 500,
    },
  );
});

test('install action events include the app name and identifier', () => {
  assert.equal(
    buildActionSummary(
      action('install', {
        appName: 'Example',
        bundleId: 'com.example.app',
        appPath: '/tmp/Example.app',
      }),
    ),
    'Installed Example (com.example.app)',
  );
  assert.equal(
    buildActionSummary(
      action('reinstall', {
        appName: 'Example',
        packageName: 'com.example.android',
      }),
    ),
    'Reinstalled Example (com.example.android)',
  );
});

test('screenshot action events prefer the client-requested filename', () => {
  const result = buildActionEventResult(
    {
      command: 'screenshot',
      meta: {
        clientArtifactPaths: {
          path: '/Users/example/artifacts/home-screen.png',
        },
      },
    },
    { path: '/tmp/agent-device-screenshot-random.png' },
  );
  const screenshot = action('screenshot', result);

  assert.equal(buildActionSummary(screenshot), 'Captured screenshot home-screen.png');
  assert.equal(buildActionDetails(screenshot).requestedFileName, 'home-screen.png');
  assert.equal(JSON.stringify(buildActionDetails(screenshot)).includes('/Users/example'), false);
});

test('screenshot action events fall back to the daemon output basename', () => {
  const result = buildActionEventResult({ command: 'screenshot' }, { path: '/tmp/screenshot.png' });

  assert.equal(
    buildActionSummary(action('screenshot', result)),
    'Captured screenshot screenshot.png',
  );
});

test('action events retain only typed command-owned flags', () => {
  const details = buildActionDetails(
    action(
      'open',
      { appBundleId: 'com.example.app' },
      {
        positionals: ['com.example.app'],
        flags: {
          platform: 'ios',
          surface: 'app',
          relaunch: true,
          launchArgs: ['plain-private-value'],
          header: ['X-Customer: private-customer'],
          replayEnv: ['CUSTOMER=private-customer'],
          replayShellEnv: { CUSTOMER: 'private-customer' },
          out: '/private/customer/output',
        },
      },
    ),
  );

  assert.deepEqual(details.flags, {
    platform: 'ios',
    surface: 'app',
    relaunch: true,
  });
  assert.equal(JSON.stringify(details).includes('private-customer'), false);
  assert.equal(JSON.stringify(details).includes('plain-private-value'), false);
  assert.equal(JSON.stringify(details).includes('/private/customer'), false);
});

test('unknown commands never project arbitrary result messages or paths', () => {
  const details = buildActionDetails(
    action('future-command', {
      message: 'customer-private-result',
      path: '/private/customer/result.txt',
      outPath: '/private/customer/output.txt',
      telemetryPath: '/private/customer/telemetry.txt',
      appName: 'private-customer-app',
      ref: 'private-customer-ref',
      x: 123,
    }),
  );

  assert.equal(buildActionSummary(action('future-command', {})), 'Ran future-command');
  assert.deepEqual(details, { command: 'future-command' });
  assert.equal(JSON.stringify(details).includes('customer-private'), false);
});

test('identity action events project only public result platforms', () => {
  const publicPlatform = buildActionDetails(
    action('open', { platform: 'ios', appBundleId: 'com.example.app' }),
  );
  const internalPlatform = buildActionDetails(
    action('open', { platform: 'apple', appBundleId: 'com.example.app' }),
  );

  assert.equal(publicPlatform.platform, 'ios');
  assert.equal(internalPlatform.platform, undefined);
});

test('structural action events preserve navigation, viewport, keyboard, and gesture outcomes', () => {
  const back = action('back', { action: 'back', mode: 'system' });
  const orientation = action('orientation', {
    action: 'orientation',
    orientation: 'landscape-left',
  });
  const viewport = action('viewport', { width: 402, height: 874 });
  const keyboard = action('keyboard', {
    action: 'dismiss',
    platform: 'ios',
    wasVisible: true,
    visible: false,
    dismissed: true,
    focusedResourceId: 'private-field-id',
  });
  const gesture = action('gesture', {
    kind: 'pan',
    durationMs: 500,
    pointerCount: 2,
    x1: 10,
    y1: 20,
    x2: 30,
    y2: 40,
    message: 'private backend message',
  });

  assert.equal(buildActionSummary(back), 'Went back using system navigation');
  assert.equal(buildActionSummary(orientation), 'Rotated to landscape-left');
  assert.equal(buildActionSummary(viewport), 'Set viewport to 402×874');
  assert.equal(buildActionSummary(keyboard), 'Dismissed keyboard');
  assert.equal(buildActionSummary(gesture), 'Ran pan gesture');
  assert.deepEqual(buildActionDetails(keyboard), {
    command: 'keyboard',
    platform: 'ios',
    action: 'dismiss',
    visible: false,
    wasVisible: true,
    dismissed: true,
  });
  assert.equal(JSON.stringify(buildActionDetails(keyboard)).includes('private-field-id'), false);
  assert.deepEqual(buildActionDetails(gesture), {
    command: 'gesture',
    x2: 30,
    y2: 40,
    durationMs: 500,
    kind: 'pan',
    pointerCount: 2,
    x1: 10,
    y1: 20,
  });
});

test('record and trace events expose only bounded artifact basenames', () => {
  const trace = action(
    'trace',
    { action: 'stop', outPath: '/private/customer/perf.trace' },
    { positionals: ['stop', '/private/customer/perf.trace'] },
  );
  const recording = action(
    'record',
    { action: 'stop', outPath: 'C:\\private\\customer\\demo.mp4', showTouches: false },
    { positionals: ['stop'] },
  );

  assert.equal(buildActionSummary(trace), 'Stopped trace perf.trace');
  assert.equal(buildActionSummary(recording), 'Stopped recording demo.mp4');
  assert.deepEqual(buildActionDetails(trace), {
    command: 'trace',
    positionals: ['<arg>', '<arg>'],
    action: 'stop',
    fileName: 'perf.trace',
  });
  assert.deepEqual(buildActionDetails(recording), {
    command: 'record',
    positionals: ['<arg>'],
    action: 'stop',
    fileName: 'demo.mp4',
    showTouches: false,
  });
});
