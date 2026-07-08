import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  appendScreenshotScriptFlags,
  SCREENSHOT_ACTION_FLAG_KEYS,
  SCREENSHOT_COMMAND_FLAG_KEYS,
  SCREENSHOT_SPECIFIC_FLAG_DEFINITIONS,
  readScreenshotScriptFlag,
  screenshotFlagsFromOptions,
  screenshotOptionsFromFlags,
} from '../../contracts/screenshot.ts';

test('screenshot flag projection maps CLI flags to runtime options', () => {
  assert.deepEqual(
    screenshotOptionsFromFlags({
      overlayRefs: true,
      screenshotPixelDensity: 2,
      screenshotFullscreen: true,
      screenshotMaxSize: 1024,
      screenshotNoStabilize: true,
      screenshotNormalizeStatusBar: true,
    }),
    {
      overlayRefs: true,
      pixelDensity: 2,
      fullscreen: true,
      maxSize: 1024,
      stabilize: false,
      normalizeStatusBar: true,
    },
  );
});

test('screenshot flag projection maps public options to request flags', () => {
  assert.deepEqual(
    screenshotFlagsFromOptions({
      overlayRefs: true,
      pixelDensity: 3,
      fullscreen: true,
      maxSize: 512,
      stabilize: false,
      normalizeStatusBar: true,
    }),
    {
      overlayRefs: true,
      screenshotPixelDensity: 3,
      screenshotFullscreen: true,
      screenshotMaxSize: 512,
      screenshotNoStabilize: true,
      screenshotNormalizeStatusBar: true,
    },
  );
});

test('screenshot script flags use the shared recorded flag contract', () => {
  const parts: string[] = [];
  const flags = {};

  let result = readScreenshotScriptFlag({ args: ['--full'], index: 0, flags });
  assert.deepEqual(result, { handled: true, nextIndex: 0 });
  result = readScreenshotScriptFlag({ args: ['-f'], index: 0, flags });
  assert.deepEqual(result, { handled: true, nextIndex: 0 });
  result = readScreenshotScriptFlag({ args: ['--fullscreen'], index: 0, flags });
  assert.deepEqual(result, { handled: true, nextIndex: 0 });
  result = readScreenshotScriptFlag({ args: ['--max-size', '640'], index: 0, flags });
  assert.deepEqual(result, { handled: true, nextIndex: 1 });
  result = readScreenshotScriptFlag({ args: ['--no-stabilize'], index: 0, flags });
  assert.deepEqual(result, { handled: true, nextIndex: 0 });
  result = readScreenshotScriptFlag({ args: ['--normalize-status-bar'], index: 0, flags });
  assert.deepEqual(result, { handled: true, nextIndex: 0 });
  result = readScreenshotScriptFlag({ args: ['--pixel-density', '3'], index: 0, flags });
  assert.deepEqual(result, { handled: true, nextIndex: 1 });

  appendScreenshotScriptFlags(parts, flags);

  assert.deepEqual(parts, [
    '--pixel-density',
    '3',
    '--fullscreen',
    '--max-size',
    '640',
    '--no-stabilize',
    '--normalize-status-bar',
  ]);
  assert.deepEqual(SCREENSHOT_ACTION_FLAG_KEYS, [
    'screenshotPixelDensity',
    'screenshotFullscreen',
    'screenshotMaxSize',
    'screenshotNoStabilize',
    'screenshotNormalizeStatusBar',
  ]);
  assert.deepEqual(
    SCREENSHOT_SPECIFIC_FLAG_DEFINITIONS.map((definition) => definition.key),
    SCREENSHOT_ACTION_FLAG_KEYS,
  );
  assert.deepEqual(SCREENSHOT_COMMAND_FLAG_KEYS, [
    'out',
    'overlayRefs',
    'screenshotPixelDensity',
    'screenshotFullscreen',
    'screenshotMaxSize',
    'screenshotNoStabilize',
    'screenshotNormalizeStatusBar',
  ]);
});
