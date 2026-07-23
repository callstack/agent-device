import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildActionEventResult } from '../session-event-action-presentation.ts';
import { buildActionDetails, buildActionSummary } from '../session-event-action.ts';
import type { SessionAction } from '../types.ts';

function action(command: string, result: Record<string, unknown>): SessionAction {
  return {
    ts: Date.now(),
    command,
    positionals: [],
    flags: {},
    result,
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
