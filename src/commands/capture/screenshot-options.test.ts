import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  appendScreenshotScriptFlags,
  SCREENSHOT_ACTION_FLAG_KEYS,
  SCREENSHOT_COMMAND_FLAG_KEYS,
  SCREENSHOT_SPECIFIC_FLAG_DEFINITIONS,
  readScreenshotScriptFlag,
  screenshotFlagsFromOptions,
  screenshotFlagsFromPublicOptions,
  screenshotOptionsFromFlags,
  validateNoRetiredScreenshotMaxSize,
  validateScreenshotScale,
  type ScreenshotRequestFlags,
} from '@agent-device/contracts/capture';

test('screenshot flag projection maps CLI flags to runtime options', () => {
  assert.deepEqual(
    screenshotOptionsFromFlags({
      overlayRefs: true,
      screenshotCropOn: 'role=button label=Save',
      screenshotPixelDensity: 2,
      screenshotFullscreen: true,
      screenshotScale: 0.3,
      screenshotNoStabilize: true,
      screenshotNormalizeStatusBar: true,
    }),
    {
      overlayRefs: true,
      cropOn: 'role=button label=Save',
      pixelDensity: 2,
      fullscreen: true,
      scale: 0.3,
      stabilize: false,
      normalizeStatusBar: true,
    },
  );
});

test('screenshot flag projection maps public options to request flags', () => {
  assert.deepEqual(
    screenshotFlagsFromOptions({
      overlayRefs: true,
      cropOn: 'label="Network & internet"',
      pixelDensity: 3,
      fullscreen: true,
      stabilize: false,
      normalizeStatusBar: true,
    }),
    {
      overlayRefs: true,
      screenshotCropOn: 'label="Network & internet"',
      screenshotPixelDensity: 3,
      screenshotFullscreen: true,
      screenshotNoStabilize: true,
      screenshotNormalizeStatusBar: true,
    },
  );
});

test('screenshot flag projection maps public scale to its request flag', () => {
  assert.deepEqual(screenshotFlagsFromPublicOptions({ scale: 0.3 }), {
    screenshotScale: 0.3,
  });
});

test('screenshot scale is bounded', () => {
  assert.doesNotThrow(() => validateScreenshotScale({ scale: 0.3 }));
  assert.throws(() => validateScreenshotScale({ scale: 0 }), /between 0\.01 and 1/);
  assert.throws(() => validateScreenshotScale({ scale: 1.01 }), /between 0\.01 and 1/);
});

test('retired max-size inputs are refused with migration guidance', () => {
  assert.throws(
    () => readScreenshotScriptFlag({ args: ['--max-size', '640'], index: 0, flags: {} }),
    {
      code: 'INVALID_ARGS',
      message: /screenshot --max-size was removed; use --scale/,
    },
  );
  assert.throws(() => validateNoRetiredScreenshotMaxSize('screenshot', { maxSize: 1024 }), {
    message: /screenshot --max-size was removed/,
  });
  assert.throws(() => validateNoRetiredScreenshotMaxSize('record', { screenshotMaxSize: 720 }), {
    message: /record --max-size was removed/,
  });
  assert.doesNotThrow(() => validateNoRetiredScreenshotMaxSize('screenshot', { scale: 0.3 }));
});

test('screenshot script flags use the shared recorded flag contract', () => {
  const parts: string[] = [];
  const flags: Partial<ScreenshotRequestFlags> = {};

  let result = readScreenshotScriptFlag({ args: ['--full'], index: 0, flags });
  assert.deepEqual(result, { handled: true, nextIndex: 0 });
  result = readScreenshotScriptFlag({ args: ['-f'], index: 0, flags });
  assert.deepEqual(result, { handled: true, nextIndex: 0 });
  result = readScreenshotScriptFlag({ args: ['--fullscreen'], index: 0, flags });
  assert.deepEqual(result, { handled: true, nextIndex: 0 });
  result = readScreenshotScriptFlag({ args: ['--scale', '0.3'], index: 0, flags });
  assert.deepEqual(result, { handled: true, nextIndex: 1 });
  result = readScreenshotScriptFlag({ args: ['--no-stabilize'], index: 0, flags });
  assert.deepEqual(result, { handled: true, nextIndex: 0 });
  result = readScreenshotScriptFlag({ args: ['--normalize-status-bar'], index: 0, flags });
  assert.deepEqual(result, { handled: true, nextIndex: 0 });
  result = readScreenshotScriptFlag({ args: ['--pixel-density', '3'], index: 0, flags });
  assert.deepEqual(result, { handled: true, nextIndex: 1 });
  result = readScreenshotScriptFlag({
    args: ['--crop-on', 'role=cell label=General || role=button label=General'],
    index: 0,
    flags,
  });
  assert.deepEqual(result, { handled: true, nextIndex: 1 });
  assert.equal(flags.screenshotCropOn, 'role=cell label=General || role=button label=General');
  assert.throws(() => readScreenshotScriptFlag({ args: ['--crop-on'], index: 0, flags: {} }), {
    code: 'INVALID_ARGS',
    message: /requires a selector expression/,
  });

  appendScreenshotScriptFlags(parts, flags);

  assert.deepEqual(parts, [
    '--pixel-density',
    '3',
    '--fullscreen',
    '--scale',
    '0.3',
    '--no-stabilize',
    '--normalize-status-bar',
  ]);
  assert.deepEqual(SCREENSHOT_ACTION_FLAG_KEYS, [
    'screenshotCropOn',
    'screenshotPixelDensity',
    'screenshotFullscreen',
    'screenshotScale',
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
    'screenshotCropOn',
    'screenshotPixelDensity',
    'screenshotFullscreen',
    'screenshotScale',
    'screenshotNoStabilize',
    'screenshotNormalizeStatusBar',
  ]);
});
