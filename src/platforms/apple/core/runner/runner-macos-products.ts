import fs from 'node:fs';
import path from 'node:path';
import { isMacOs, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError, asAppError } from '@agent-device/kernel/errors';
import { runAppleToolCommand } from '../tool-provider.ts';

const RUNNER_PRODUCT_REPAIR_FAILURE_REASONS = new Set([
  'RUNNER_PRODUCT_MISSING',
  'RUNNER_PRODUCT_REPAIR_FAILED',
]);

const AD_HOC_RESIGN_ARGS = [
  '--force',
  // Designated requirements must be regenerated for the ad-hoc identity.
  '--preserve-metadata=identifier,entitlements,flags,runtime',
  '--sign',
  '-',
] as const;

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
    await resignRunnerProduct(productPath, xctestrunPath);
  }
}

async function resignRunnerProduct(productPath: string, xctestrunPath: string): Promise<void> {
  try {
    const frameworksPath = path.join(productPath, 'Contents', 'Frameworks');
    const embeddedCodePaths = fs.existsSync(frameworksPath)
      ? fs
          .readdirSync(frameworksPath)
          .sort()
          .map((itemName) => path.join(frameworksPath, itemName))
      : [];
    for (const embeddedCodePath of embeddedCodePaths) {
      await runAppleToolCommand('codesign', [...AD_HOC_RESIGN_ARGS, embeddedCodePath]);
    }
    await runAppleToolCommand('codesign', [...AD_HOC_RESIGN_ARGS, productPath]);
  } catch (error) {
    const appError = asAppError(error, 'COMMAND_FAILED');
    throw repairFailure(productPath, xctestrunPath, appError.message, appError.details);
  }

  if (!(await hasValidCodeSignature(productPath))) {
    throw repairFailure(
      productPath,
      xctestrunPath,
      'Product still fails code signature verification after re-signing',
    );
  }
}

function repairFailure(
  productPath: string,
  xctestrunPath: string,
  error: string,
  details?: unknown,
): AppError {
  return new AppError('COMMAND_FAILED', 'Failed to repair macOS runner product signature', {
    reason: 'RUNNER_PRODUCT_REPAIR_FAILED',
    productPath,
    xctestrunPath,
    error,
    details,
  });
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
