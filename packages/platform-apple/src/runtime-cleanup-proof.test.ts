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

test.each(['local-drained', 'unsupported'] as const)(
  'Apple binding advertises cleanup recovery only for an explicitly %s host',
  async (scope) => {
    const root = mkdtempForTestSync('apple-binding-proof-');
    try {
      const base = platformRuntimeHostFixture();
      const host = {
        ...base,
        hostEnvironment: createTestHostEnvironment({
          env: { ...process.env, AGENT_DEVICE_CLAIMS_DIR: path.join(root, 'claims') },
        }),
        screenRecording: {
          ...base.screenRecording,
          apple: { ...base.screenRecording.apple, cleanupRecoveryScope: async () => scope },
        },
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
      expect(binding.recordingCleanupRecovery).toBe(scope === 'local-drained' ? scope : undefined);
      await binding[Symbol.asyncDispose]();
      await runtime.shutdown();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
