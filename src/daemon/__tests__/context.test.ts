import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { CommandFlags } from '../../core/dispatch.ts';
import { contextFromFlags } from '../context.ts';

test('contextFromFlags propagates back mode into the dispatch context', () => {
  const context = contextFromFlags('/tmp/agent-device.log', { backMode: 'system' });
  assert.equal(context.backMode, 'system');
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
    screenshotMaxSize: 1024,
    screenshotNoStabilize: true,
  };
  const context = contextFromFlags('/tmp/agent-device.log', flags);
  assert.equal(context.screenshotFullscreen, true);
  assert.equal(context.screenshotMaxSize, 1024);
  assert.equal(context.screenshotNoStabilize, true);
});
