import type { CommandFlags } from '@agent-device/contracts/command';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { contextFromFlags } from '../context.ts';

test('contextFromFlags propagates back mode into the dispatch context', () => {
  const context = contextFromFlags('/tmp/agent-device.log', { backMode: 'system' });
  assert.equal(context.backMode, 'system');
});

test('contextFromFlags forwards the Maestro runner screenshot backend', () => {
  const context = contextFromFlags('/tmp/agent-device.log', {
    maestro: { screenshotCaptureBackend: 'runner' },
  });
  assert.equal(context.screenshotCaptureBackend, 'runner');
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
