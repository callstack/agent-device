import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { WAIT_REASONS } from '@agent-device/contracts/wait';
import { mkdtempForTestSync } from '@agent-device/test-kit';
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
  const appleTool = createRecordingAppleToolProvider({
    simctl: async (args) => {
      if (args[0] === 'list') {
        return {
          stdout: JSON.stringify({
            devices: {
              'iOS 18.5': [{ udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id, state: 'Booted' }],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'launch') return { stdout: '', stderr: '', exitCode: 0 };
      throw new Error(`Unexpected Apple simulator call: ${args.join(' ')}`);
    },
  });
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
  try {
    await daemon.client().apps.open({
      app: 'com.example.demo',
      platform: 'ios',
      udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
    });
    commands.length = 0;
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
      target === 'selector'
        ? ['snapshot', 'snapshot', 'snapshot']
        : ['snapshot', 'snapshot', 'findText', 'snapshot'],
    );
  } finally {
    await daemon.close();
  }
});

test('Apple wait text ignores a text field’s typed value but matches its label', async () => {
  const appleTool = createRecordingAppleToolProvider({
    simctl: async (args) => {
      if (args[0] === 'list') {
        return {
          stdout: JSON.stringify({
            devices: {
              'iOS 18.5': [{ udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id, state: 'Booted' }],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'launch') return { stdout: '', stderr: '', exitCode: 0 };
      throw new Error(`Unexpected Apple simulator call: ${args.join(' ')}`);
    },
  });
  const daemon = await createProviderScenarioHarness({
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_IOS_SIMULATOR],
    appleToolProvider: () => appleTool.provider,
    appleRunnerProvider: () => ({
      hasLiveSession: () => true,
      runCommand: async (_device, command) => {
        if (command.command === 'findText') return { found: false };
        assert.equal(command.command, 'snapshot');
        return {
          nodes: [
            {
              index: 0,
              type: 'Application',
              label: 'Contacts',
              rect: { x: 0, y: 0, width: 393, height: 852 },
            },
            {
              index: 1,
              parentIndex: 0,
              type: 'TextField',
              label: 'First name',
              value: 'benchad',
              rect: { x: 16, y: 200, width: 361, height: 44 },
            },
          ],
        };
      },
    }),
  });
  try {
    await daemon.client().apps.open({
      app: 'com.apple.MobileAddressBook',
      platform: 'ios',
      udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
    });
    const flags = { platform: 'ios' as const };
    const typed = await daemon.callCommand('wait', ['text', 'benchad', '1000'], flags);
    assert.equal(typed.json?.error?.data?.details?.reason, WAIT_REASONS.targetAbsent);
    assert.equal(
      assertRpcOk(await daemon.callCommand('wait', ['text', 'First name', '100'], flags)).text,
      'First name',
    );
  } finally {
    await daemon.close();
  }
});
