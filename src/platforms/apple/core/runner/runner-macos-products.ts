import fs from 'node:fs';
import { isMacOs, type DeviceInfo } from '../../../../kernel/device.ts';
import { AppError, asAppError } from '../../../../kernel/errors.ts';
import { runAppleToolCommand } from '../tool-provider.ts';

const RUNNER_PRODUCT_REPAIR_FAILURE_REASONS = new Set([
  'RUNNER_PRODUCT_MISSING',
  'RUNNER_PRODUCT_REPAIR_FAILED',
]);

export async function repairMacOsRunnerProductsIfNeeded(
  device: DeviceInfo,
  productPaths: string[],
  xctestrunPath: string,
): Promise<void> {
  if (!isMacOs(device)) {
    return;
  }
  if (productPaths.length === 0) {
    throw new AppError('COMMAND_FAILED', 'Missing macOS runner product', {
      reason: 'RUNNER_PRODUCT_MISSING',
      xctestrunPath,
    });
  }
  const sortedProductPaths = Array.from(new Set(productPaths)).sort(
    (left, right) => right.length - left.length,
  );
  for (const productPath of sortedProductPaths) {
    if (!fs.existsSync(productPath)) {
      throw new AppError('COMMAND_FAILED', 'Missing macOS runner product', {
        reason: 'RUNNER_PRODUCT_MISSING',
        productPath,
        xctestrunPath,
      });
    }
  }

  for (const productPath of sortedProductPaths) {
    if (await hasValidCodeSignature(productPath)) {
      continue;
    }
    await runAppleToolCommand('codesign', ['--remove-signature', productPath], {
      allowFailure: true,
    });
    try {
      await runAppleToolCommand('codesign', ['--force', '--sign', '-', productPath]);
    } catch (error) {
      const appError = asAppError(error, 'COMMAND_FAILED');
      throw new AppError('COMMAND_FAILED', 'Failed to repair macOS runner product signature', {
        reason: 'RUNNER_PRODUCT_REPAIR_FAILED',
        productPath,
        xctestrunPath,
        error: appError.message,
        details: appError.details,
      });
    }
  }
}

export function isExpectedRunnerRepairFailure(error: unknown): boolean {
  if (!(error instanceof AppError)) {
    return false;
  }
  const reason =
    error.details && typeof error.details === 'object'
      ? (error.details as Record<string, unknown>).reason
      : undefined;
  return typeof reason === 'string' && RUNNER_PRODUCT_REPAIR_FAILURE_REASONS.has(reason);
}

async function hasValidCodeSignature(productPath: string): Promise<boolean> {
  const result = await runAppleToolCommand(
    'codesign',
    ['--verify', '--deep', '--strict', productPath],
    {
      allowFailure: true,
    },
  );
  return result.exitCode === 0;
}
