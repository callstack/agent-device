import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { test } from 'vitest';

import { MACOS_DEVICE } from './device-fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';
import { AppError } from '@agent-device/kernel/errors';
import {
  isExpectedRunnerRepairFailure,
  repairMacOsRunnerProductsIfNeeded,
} from '../runner-macos-products.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import type { ExecOptions, ExecResult } from '../host.ts';

const XCTESTRUN_PATH = '/tmp/agent-device-runner.xctestrun';

test('repair discovers and re-signs nested code before the product', async () => {
  const { productPath, embeddedItemPaths } = createProduct();
  const calls: string[][] = [];
  installCodesignHost(calls, (args) => args.includes('--sign') && args.at(-1) === productPath);

  await repairMacOsRunnerProductsIfNeeded(MACOS_DEVICE, [productPath], XCTESTRUN_PATH);

  const signingArgs = [
    '--force',
    '--preserve-metadata=identifier,entitlements,flags,runtime',
    '--sign',
    '-',
  ];
  assert.deepEqual(calls.slice(1, -1), [
    ...embeddedItemPaths.map((itemPath) => [...signingArgs, itemPath]),
    [...signingArgs, productPath],
  ]);
  assert.deepEqual(calls.at(-1), ['--verify', '--deep', '--strict', productPath]);
});

test('repair fails when re-signing leaves the product unverifiable', async () => {
  const productPath = createProductPath();
  installCodesignHost([], () => false);

  const error = await repairMacOsRunnerProductsIfNeeded(
    MACOS_DEVICE,
    [productPath],
    XCTESTRUN_PATH,
  ).then(
    () => null,
    (thrown: unknown) => thrown,
  );

  assert.ok(error instanceof AppError);
  assert.equal(isExpectedRunnerRepairFailure(error), true);
});

function createProductPath(): string {
  return createProduct().productPath;
}

function createProduct(): {
  productPath: string;
  embeddedItemPaths: string[];
} {
  const root = mkdtempForTestSync('agent-device-runner-products-');
  const productPath = path.join(root, 'AgentDeviceRunnerUITests-Runner.app');
  fs.mkdirSync(productPath);
  const frameworksRoot = path.join(productPath, 'Contents', 'Frameworks');
  const embeddedItemPaths = [
    'FutureTestSupport.framework',
    'AnotherTestSupport.framework',
    'libFutureTestSupport.dylib',
  ].map((itemName) => path.join(frameworksRoot, itemName));
  for (const itemPath of embeddedItemPaths) {
    if (itemPath.endsWith('.framework')) {
      fs.mkdirSync(itemPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(itemPath), { recursive: true });
      fs.writeFileSync(itemPath, '');
    }
  }
  return { productPath, embeddedItemPaths: embeddedItemPaths.sort() };
}

function installCodesignHost(
  calls: string[][],
  isRepairingSignature: (args: readonly string[]) => boolean,
): void {
  let repaired = false;
  appleRunnerTestHost.update({
    runAppleToolCommand: async (
      command: string,
      args: string[] = [],
      _options?: ExecOptions,
    ): Promise<ExecResult> => {
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
