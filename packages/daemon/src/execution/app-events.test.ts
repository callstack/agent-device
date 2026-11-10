import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  ANDROID_EMULATOR,
  IOS_DEVICE,
  MACOS_DEVICE,
  WEB_DESKTOP_DEVICE,
} from '@agent-device/test-kit';
import { parseTriggerAppEventArgs, resolveAppEventUrl } from './app-events.ts';
import { AppError } from '@agent-device/kernel/errors';

// resolveAppEventUrl takes the runtime host's env, so the tests name the env they mean rather
// than mutating the process environment.
const NO_TEMPLATE: NodeJS.ProcessEnv = {};

test('parseTriggerAppEventArgs validates event name format', () => {
  assert.throws(
    () => parseTriggerAppEventArgs(['bad event']),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /Invalid trigger-app-event event name/i.test(error.message),
  );
});

test('trigger-app-event reports missing URL template as UNSUPPORTED_OPERATION', () => {
  assert.throws(
    () => resolveAppEventUrl(ANDROID_EMULATOR, 'screenshot_taken', undefined, NO_TEMPLATE),
    (error) =>
      error instanceof AppError &&
      error.code === 'UNSUPPORTED_OPERATION' &&
      /No app event URL template configured/i.test(error.message),
  );
});

test('trigger-app-event on web ignores the Android template and hints only variables it reads', () => {
  assert.throws(
    () =>
      resolveAppEventUrl(WEB_DESKTOP_DEVICE, 'screenshot_taken', undefined, {
        AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE: 'myapp://android?name={event}',
        AGENT_DEVICE_WEB_APP_EVENT_URL_TEMPLATE: 'myapp://web?name={event}',
      }),
    (error) =>
      error instanceof AppError &&
      error.code === 'UNSUPPORTED_OPERATION' &&
      error.details?.hint ===
        'Set AGENT_DEVICE_APP_EVENT_URL_TEMPLATE, for example "myapp://agent-device/event?name={event}&payload={payload}".',
  );
  assert.equal(
    resolveAppEventUrl(WEB_DESKTOP_DEVICE, 'screenshot_taken', undefined, {
      AGENT_DEVICE_APP_EVENT_URL_TEMPLATE: 'myapp://global?name={event}&platform={platform}',
    }),
    'myapp://global?name=screenshot_taken&platform=web',
  );
});

test('trigger-app-event hint names the Android and global variables for Android', () => {
  assert.throws(
    () => resolveAppEventUrl(ANDROID_EMULATOR, 'screenshot_taken', undefined, NO_TEMPLATE),
    (error) =>
      error instanceof AppError &&
      typeof error.details?.hint === 'string' &&
      error.details.hint.startsWith(
        'Set AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE or AGENT_DEVICE_APP_EVENT_URL_TEMPLATE,',
      ),
  );
});

test('trigger-app-event validates payload JSON', () => {
  assert.throws(
    () => parseTriggerAppEventArgs(['screenshot_taken', '{invalid-json']),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /Invalid trigger-app-event payload JSON/i.test(error.message),
  );
});

test('trigger-app-event prefers a platform-specific URL template over the global template', () => {
  const { eventName, payload } = parseTriggerAppEventArgs(['screenshot_taken']);
  assert.equal(
    resolveAppEventUrl(ANDROID_EMULATOR, eventName, payload, {
      AGENT_DEVICE_APP_EVENT_URL_TEMPLATE: 'myapp://global?name={event}',
      AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE: 'myapp://android?name={event}',
    }),
    'myapp://android?name=screenshot_taken',
  );
});

test('trigger-app-event supports iOS and prefers its platform-specific URL template', () => {
  const { eventName, payload } = parseTriggerAppEventArgs(['screenshot_taken', '{"source":"ios"}']);
  assert.equal(
    resolveAppEventUrl(IOS_DEVICE, eventName, payload, {
      AGENT_DEVICE_APP_EVENT_URL_TEMPLATE: 'myapp://global?name={event}',
      AGENT_DEVICE_IOS_APP_EVENT_URL_TEMPLATE:
        'myapp://ios?name={event}&payload={payload}&platform={platform}',
    }),
    'myapp://ios?name=screenshot_taken&payload=%7B%22source%22%3A%22ios%22%7D&platform=ios',
  );
});

test('trigger-app-event supports macOS and prefers macOS template', () => {
  const { eventName, payload } = parseTriggerAppEventArgs([
    'screenshot_taken',
    '{"source":"desktop"}',
  ]);
  assert.equal(
    resolveAppEventUrl(MACOS_DEVICE, eventName, payload, {
      AGENT_DEVICE_APP_EVENT_URL_TEMPLATE: 'myapp://global?name={event}',
      AGENT_DEVICE_MACOS_APP_EVENT_URL_TEMPLATE:
        'myapp://macos?name={event}&payload={payload}&platform={platform}',
    }),
    'myapp://macos?name=screenshot_taken&payload=%7B%22source%22%3A%22desktop%22%7D&platform=macos',
  );
});

test('trigger-app-event rejects payloads that exceed size limits', () => {
  const oversizedPayload = JSON.stringify({ value: 'x'.repeat(9000) });
  assert.throws(
    () => parseTriggerAppEventArgs(['screenshot_taken', oversizedPayload]),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /exceeds 8192 bytes/i.test(error.message),
  );
});

test('trigger-app-event rejects event URLs that exceed length limits', () => {
  assert.throws(
    () =>
      resolveAppEventUrl(ANDROID_EMULATOR, 'screenshot_taken', undefined, {
        AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE: `myapp://${'a'.repeat(5000)}?name={event}`,
      }),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /URL exceeds maximum supported length/i.test(error.message),
  );
});
