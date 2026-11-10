import type { CommandFlags } from '@agent-device/contracts/command';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { contextFromFlags, requestCwd } from '../context.ts';
import type { DaemonRequest } from '../daemon-request.ts';

test('contextFromFlags propagates back mode into the dispatch context', () => {
  const context = contextFromFlags('/tmp/agent-device.log', { backMode: 'system' });
  assert.equal(context.backMode, 'system');
});

test('contextFromFlags keeps an explicit capture backend apart from the Maestro preference', () => {
  const explicit = contextFromFlags('/tmp/agent-device.log', {
    screenshotCaptureBackend: 'runner',
  });
  assert.equal(explicit.screenshotCaptureBackend, 'runner');
  assert.equal(explicit.preferredScreenshotCaptureBackend, undefined);
  const preferred = contextFromFlags('/tmp/agent-device.log', {
    maestro: { screenshotCaptureBackend: 'runner' },
  });
  assert.equal(preferred.screenshotCaptureBackend, undefined);
  assert.equal(preferred.preferredScreenshotCaptureBackend, 'runner');
});

test('contextFromFlags forwards scroll pixels from CLI flags', () => {
  const flags: CommandFlags = { pixels: 240 };
  const context = contextFromFlags('/tmp/agent-device.log', flags);
  assert.equal(context.pixels, 240);
});

test('contextFromFlags forwards generic app-state clearing', () => {
  const flags: CommandFlags = { clearAppState: true };
  const context = contextFromFlags('/tmp/agent-device.log', flags);
  assert.equal(context.clearAppState, true);
});

test('contextFromFlags forwards screenshot flags from CLI flags', () => {
  const flags: CommandFlags = {
    screenshotFullscreen: true,
    screenshotScale: 0.3,
    screenshotNoStabilize: true,
  };
  const context = contextFromFlags('/tmp/agent-device.log', flags);
  assert.equal(context.screenshotFullscreen, true);
  assert.equal(context.screenshotScale, 0.3);
  assert.equal(context.screenshotNoStabilize, true);
});

test('requestCwd uses the caller cwd only when it is a string', () => {
  const host = { cwd: '/daemon' };
  assert.equal(requestCwd({ meta: { cwd: '/caller' } }, host), '/caller');
  assert.equal(requestCwd({}, host), '/daemon');
  // The RPC schema checks meta only as an object, so a peer can send any cwd value.
  for (const cwd of [42, null, ['/caller'], { path: '/caller' }]) {
    const req = { meta: { cwd } } as unknown as Pick<DaemonRequest, 'meta'>;
    assert.equal(requestCwd(req, host), '/daemon');
  }
});
