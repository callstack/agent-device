import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';
import { createFailNthCommandExecutor } from '../../../__tests__/test-utils/exec-faults.ts';
import { withCommandExecutorOverride } from '@agent-device/host-kit/command';
import { createAgentBrowserWebProvider } from '../agent-browser-provider.ts';
import { installFakeManagedAgentBrowser } from './test-utils.ts';

const COMMAND_CLASS_OPERATIONS = {
  mutation: (provider: ReturnType<typeof createAgentBrowserWebProvider>) => provider.click(10, 20),
  read: async (provider: ReturnType<typeof createAgentBrowserWebProvider>) => {
    await provider.snapshot();
  },
  'artifact-producing': (provider: ReturnType<typeof createAgentBrowserWebProvider>) =>
    provider.screenshot('/tmp/boundary-fault.png'),
  'session-lifecycle': (provider: ReturnType<typeof createAgentBrowserWebProvider>) =>
    provider.open('https://example.test'),
} as const;

for (const [commandClass, runOperation] of Object.entries(COMMAND_CLASS_OPERATIONS)) {
  test(`agent-browser fail-Nth subprocess fault is not replayed for ${commandClass}`, async () => {
    const stateDir = mkdtempForTestSync(`agent-device-exec-boundary-${commandClass}-`);
    try {
      installFakeManagedAgentBrowser(stateDir);
      const provider = createAgentBrowserWebProvider({ stateDir, session: 'boundary' });
      const failure = new AppError('COMMAND_FAILED', 'injected command failure', {
        hint: 'retry the boundary test',
        diagnosticId: `diag-${commandClass}`,
        logPath: `/tmp/${commandClass}.ndjson`,
      });
      const driver = createFailNthCommandExecutor(1, failure);

      await assert.rejects(
        withCommandExecutorOverride(driver.override, async () => await runOperation(provider)),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, 'COMMAND_FAILED');
          assert.equal(error.message, 'injected command failure');
          assert.equal(error.details?.hint, 'retry the boundary test');
          assert.equal(error.details?.diagnosticId, `diag-${commandClass}`);
          assert.equal(error.details?.logPath, `/tmp/${commandClass}.ndjson`);
          return true;
        },
      );
      assert.equal(driver.calls().length, 1, 'the failed command must not be replayed');
    } finally {
      fs.rmSync(stateDir, { force: true, recursive: true });
    }
  });
}
