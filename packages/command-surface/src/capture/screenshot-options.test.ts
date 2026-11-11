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
      screenshotScreenMask: 'black',
      screenshotFullscreen: true,
      screenshotScale: 0.3,
      screenshotNoStabilize: true,
      screenshotNormalizeStatusBar: true,
      screenshotCaptureBackend: 'runner',
    }),
    {
      overlayRefs: true,
      cropOn: 'role=button label=Save',
      pixelDensity: 2,
      screenMask: 'black',
      fullscreen: true,
      scale: 0.3,
      stabilize: false,
      normalizeStatusBar: true,
      captureBackend: 'runner',
    },
  );
});

test('screenshot flag projection maps public options to request flags', () => {
  assert.deepEqual(
    screenshotFlagsFromOptions({
      overlayRefs: true,
      cropOn: 'label="Network & internet"',
      pixelDensity: 3,
      screenMask: 'black',
      fullscreen: true,
      stabilize: false,
      normalizeStatusBar: true,
      captureBackend: 'runner',
    }),
    {
      overlayRefs: true,
      screenshotCropOn: 'label="Network & internet"',
      screenshotPixelDensity: 3,
      screenshotScreenMask: 'black',
      screenshotFullscreen: true,
      screenshotNoStabilize: true,
      screenshotNormalizeStatusBar: true,
      screenshotCaptureBackend: 'runner',
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

  result = readScreenshotScriptFlag({ args: ['--screen-mask', 'black'], index: 0, flags });
  assert.deepEqual(result, { handled: true, nextIndex: 1 });
  assert.equal(flags.screenshotScreenMask, 'black');
  assert.throws(
    () => readScreenshotScriptFlag({ args: ['--screen-mask', 'alpha'], index: 0, flags: {} }),
    { code: 'INVALID_ARGS' },
  );
  assert.throws(() => readScreenshotScriptFlag({ args: ['--screen-mask'], index: 0, flags: {} }), {
    code: 'INVALID_ARGS',
  });
  appendScreenshotScriptFlags(parts, flags);

  assert.deepEqual(parts, [
    '--pixel-density',
    '3',
    '--screen-mask',
    'black',
    '--fullscreen',
    '--scale',
    '0.3',
    '--no-stabilize',
    '--normalize-status-bar',
  ]);
  assert.deepEqual(SCREENSHOT_ACTION_FLAG_KEYS, [
    'screenshotCropOn',
    'screenshotPixelDensity',
    'screenshotScreenMask',
    'screenshotNativeDensity',
    'screenshotFullscreen',
    'screenshotScale',
    'screenshotNoStabilize',
    'screenshotNormalizeStatusBar',
    'screenshotCaptureBackend',
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
    'screenshotScreenMask',
    'screenshotNativeDensity',
    'screenshotFullscreen',
    'screenshotScale',
    'screenshotNoStabilize',
    'screenshotNormalizeStatusBar',
    'screenshotCaptureBackend',
  ]);
});

test('the capture backend stays out of recorded scripts', () => {
  const parts: string[] = [];
  appendScreenshotScriptFlags(parts, { screenshotCaptureBackend: 'runner' });
  assert.deepEqual(parts, []);
  assert.equal(
    SCREENSHOT_SPECIFIC_FLAG_DEFINITIONS.find(({ key }) => key === 'screenshotCaptureBackend')
      ?.recorded,
    false,
  );
});

test('explicit screenshot stabilization survives SDK projection and script recording', () => {
  const projected = screenshotFlagsFromOptions({ stabilize: true });
  assert.deepEqual(screenshotOptionsFromFlags(projected), { stabilize: true });
  const parts: string[] = [];
  appendScreenshotScriptFlags(parts, projected);
  assert.deepEqual(parts, ['--no-stabilize=false']);
  const recorded: Partial<ScreenshotRequestFlags> = {};
  assert.deepEqual(readScreenshotScriptFlag({ args: parts, index: 0, flags: recorded }), {
    handled: true,
    nextIndex: 0,
  });
  assert.deepEqual(screenshotOptionsFromFlags(recorded), { stabilize: true });
});

test('native density survives script recording and replay', () => {
  const projected = screenshotFlagsFromOptions({ nativeDensity: true });
  const parts: string[] = [];
  appendScreenshotScriptFlags(parts, projected);
  assert.deepEqual(parts, ['--native-density']);
  const recorded: Partial<ScreenshotRequestFlags> = {};
  assert.deepEqual(readScreenshotScriptFlag({ args: parts, index: 0, flags: recorded }), {
    handled: true,
    nextIndex: 0,
  });
  assert.deepEqual(screenshotOptionsFromFlags(recorded), { nativeDensity: true });
});
