import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { test } from 'vitest';

import { MACOS_DEVICE } from '../../../../__tests__/test-utils/device-fixtures.ts';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';
import { AppError } from '@agent-device/kernel/errors';
import {
  isExpectedRunnerRepairFailure,
  repairMacOsRunnerProductsIfNeeded,
} from '../runner/runner-macos-products.ts';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../tool-provider.ts';

const XCTESTRUN_PATH = '/tmp/agent-device-runner.xctestrun';

test('repair re-signs nested code so the product passes deep verification', async () => {
  const productPath = createProductPath();
  const calls: string[][] = [];
  // Nested Apple test frameworks lose their sealed Modules/ entries during the unsigned embed,
  // so only a signature that reaches nested code clears deep verification.
  const provider = createCodesignProvider(
    calls,
    (args) => args.includes('--deep') && args.includes('--sign'),
  );

  await withAppleToolProvider(provider, async () => {
    await repairMacOsRunnerProductsIfNeeded(MACOS_DEVICE, [productPath], XCTESTRUN_PATH);
  });

  assert.deepEqual(calls.at(-2), ['--force', '--deep', '--sign', '-', productPath]);
  assert.deepEqual(calls.at(-1), ['--verify', '--deep', '--strict', productPath]);
});

test('repair fails when re-signing leaves the product unverifiable', async () => {
  const productPath = createProductPath();
  const provider = createCodesignProvider([], () => false);

  const error = await withAppleToolProvider(
    provider,
    async () =>
      await repairMacOsRunnerProductsIfNeeded(MACOS_DEVICE, [productPath], XCTESTRUN_PATH).then(
        () => null,
        (thrown: unknown) => thrown,
      ),
  );

  assert.ok(error instanceof AppError);
  assert.equal(isExpectedRunnerRepairFailure(error), true);
});

function createProductPath(): string {
  const root = mkdtempForTestSync('agent-device-runner-products-');
  const productPath = path.join(root, 'AgentDeviceRunnerUITests-Runner.app');
  fs.mkdirSync(productPath);
  return productPath;
}

function createCodesignProvider(
  calls: string[][],
  isRepairingSignature: (args: readonly string[]) => boolean,
) {
  let repaired = false;
  return createLocalAppleToolProvider({
    runCommand: async (command, args = []) => {
      assert.equal(command, 'codesign');
      calls.push([...args]);
      if (isRepairingSignature(args)) {
        repaired = true;
      }
      const verifying = args[0] === '--verify';
      return {
        exitCode: verifying && !repaired ? 1 : 0,
        stdout: '',
        stderr: '',
      };
    },
  });
}
