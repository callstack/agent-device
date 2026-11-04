import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  createTestHostEnvironment,
  IOS_SIMULATOR,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import { createApplePlatformRuntime } from './runtime.ts';
import { platformRuntimeHostFixture } from './runtime.fixtures.ts';

test('an Apple runtime binding does not attest that compiler descendants have drained', async () => {
  const root = mkdtempForTestSync('apple-binding-proof-');
  try {
    const base = platformRuntimeHostFixture();
    const host = {
      ...base,
      hostEnvironment: createTestHostEnvironment({
        env: { ...process.env, AGENT_DEVICE_CLAIMS_DIR: path.join(root, 'claims') },
      }),
    };
    const runtime = createApplePlatformRuntime(host);
    const binding = await runtime.bind({
      device: IOS_SIMULATOR,
      intent: { kind: 'ordinary' },
      scope: {
        signal: new AbortController().signal,
        diagnostics: { emit: () => {} },
        progress: { report: () => {} },
      },
    });
    expect(binding).not.toHaveProperty('recordingCleanupRecovery');
    await binding[Symbol.asyncDispose]();
    await runtime.shutdown();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
