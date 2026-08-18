import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';

// `ai` is an optional peer dependency; this simulates the real "not installed"
// resolution failure a consumer would hit, isolated to its own file so the
// other ai-sdk tests can still exercise the real, installed `ai` package.
vi.mock('ai', () => {
  throw new Error("Cannot find package 'ai' imported from agent-device/ai-sdk");
});

const { createAgentDeviceTools } = await import('../index.ts');

test('createAgentDeviceTools() reports a clear error when the optional peer dependency is missing', async () => {
  await assert.rejects(createAgentDeviceTools({ session: 's' }), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'MISSING_PEER_DEPENDENCY');
    assert.match(error.message, /requires the optional peer dependency 'ai'/);
    assert.match(error.message, /pnpm add ai/);
    return true;
  });
});
