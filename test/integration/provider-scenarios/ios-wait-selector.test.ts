import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { makeIosAppSession } from '../../../src/__tests__/test-utils/session-factories.ts';
import { mkdtempForTestSync } from '../../../src/__tests__/test-utils/tmp-dir.ts';
import { PROVIDER_SCENARIO_IOS_SIMULATOR } from './fixtures.ts';
import { assertRpcOk } from './assertions.ts';
import { createProviderScenarioHarness } from './harness.ts';
import { createRecordingAppleToolProvider } from './providers.ts';

test.each([
  ['wait', 'selector'],
  ['replay', 'selector'],
  ['wait', 'text'],
  ['replay', 'text'],
] as const)('Apple %s %s captures like is when native queries fail', async (command, target) => {
  const commands: string[] = [];
  const appleTool = createRecordingAppleToolProvider();
  const daemon = await createProviderScenarioHarness({
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_IOS_SIMULATOR],
    appleToolProvider: () => appleTool.provider,
    appleRunnerProvider: () => ({
      hasLiveSession: () => true,
      runCommand: async (_device, command) => {
        commands.push(command.command);
        if (command.command === 'querySelector' || command.command === 'findText') {
          throw new AppError(
            'COMMAND_FAILED',
            `XCTest recorded a failure while executing ${command.command}`,
            { reason: 'XCTEST_RECORDED_FAILURE' },
          );
        }
        assert.equal(command.command, 'snapshot');
        return {
          nodes: [
            {
              index: 0,
              type: 'Application',
              label: 'Example',
              rect: { x: 0, y: 0, width: 393, height: 852 },
            },
            {
              index: 1,
              parentIndex: 0,
              type: 'Other',
              identifier: 'LANDMARK_A',
              label: 'Ready',
              rect: { x: 10, y: 10, width: 100, height: 100 },
            },
          ],
        };
      },
    }),
  });
  daemon.setSession('default', {
    ...makeIosAppSession('default'),
    device: PROVIDER_SCENARIO_IOS_SIMULATOR,
  });
  try {
    const flags = { platform: 'ios' as const };
    assert.equal(
      assertRpcOk(await daemon.callCommand('is', ['visible', 'id="LANDMARK_A"'], flags)).pass,
      true,
    );
    const root = mkdtempForTestSync('ios-wait-replay-');
    const scriptPath = path.join(root, 'flow.ad');
    fs.writeFileSync(
      scriptPath,
      (target === 'selector' ? String.raw`wait "id=\"LANDMARK_A\"" 200` : 'wait text "Ready" 200') +
        '\n',
    );
    assertRpcOk(
      await daemon.callCommand(
        command,
        command === 'replay'
          ? [scriptPath]
          : target === 'selector'
            ? ['id="LANDMARK_A"', '200']
            : ['text', 'Ready', '200'],
        flags,
      ),
    );
    assert.deepEqual(
      commands,
      target === 'selector' ? ['snapshot', 'snapshot'] : ['snapshot', 'findText', 'snapshot'],
    );
  } finally {
    await daemon.close();
  }
});
