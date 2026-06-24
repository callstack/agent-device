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
      screenshotFullscreen: true,
      screenshotMaxSize: 1024,
      screenshotNoStabilize: true,
    }),
    {
      overlayRefs: true,
      fullscreen: true,
      maxSize: 1024,
      stabilize: false,
    },
  );
});

test('screenshot flag projection maps public options to request flags', () => {
  assert.deepEqual(
    screenshotFlagsFromOptions({
      overlayRefs: true,
      fullscreen: true,
      maxSize: 512,
      stabilize: false,
    }),
    {
      overlayRefs: true,
      screenshotFullscreen: true,
      screenshotMaxSize: 512,
      screenshotNoStabilize: true,
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

  appendScreenshotScriptFlags(parts, flags);

  assert.deepEqual(parts, ['--fullscreen', '--max-size', '640', '--no-stabilize']);
  assert.deepEqual(SCREENSHOT_ACTION_FLAG_KEYS, [
    'screenshotFullscreen',
    'screenshotMaxSize',
    'screenshotNoStabilize',
  ]);
  assert.deepEqual(
    SCREENSHOT_SPECIFIC_FLAG_DEFINITIONS.map((definition) => definition.key),
    SCREENSHOT_ACTION_FLAG_KEYS,
  );
  assert.deepEqual(SCREENSHOT_COMMAND_FLAG_KEYS, [
    'out',
    'overlayRefs',
    'screenshotFullscreen',
    'screenshotMaxSize',
    'screenshotNoStabilize',
  ]);
});
