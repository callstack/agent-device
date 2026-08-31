import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { asRecord } from './result-values.ts';
import type { PackageSize } from './types.ts';

export function measurePackageSize(repoRoot: string, revision: string): PackageSize {
  const reportPath = path.join(repoRoot, '.tmp', `ios-size-${process.pid}-${Date.now()}.json`);
  try {
    runSizeReport(repoRoot, reportPath);
    return readPackageSize(reportPath, revision);
  } finally {
    removeReport(reportPath);
  }
}

export function notRunPackageSize(revision: string): PackageSize {
  return { status: 'not-run', revision };
}

function runSizeReport(repoRoot: string, reportPath: string): void {
  execFileSync(
    process.execPath,
    ['scripts/size-report.mjs', '--cwd', repoRoot, '--json', reportPath],
    {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'inherit'],
      timeout: 10 * 60 * 1000,
    },
  );
}

function readPackageSize(reportPath: string, revision: string): PackageSize {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
  const npmPack = asRecord(report.npmPack);
  const cleanInstalled = asRecord(report.cleanInstalled);
  const bundled = asRecord(report.bundled);
  return {
    status: 'measured',
    revision,
    packed: readPackedSize(npmPack),
    cleanInstalled: readCleanInstalledSize(cleanInstalled),
    bundled: readBundledSize(bundled),
  };
}

function readPackedSize(
  value: Record<string, unknown> | undefined,
): NonNullable<PackageSize['packed']> {
  return {
    tarballBytes: readInteger(value?.tarballBytes),
    unpackedBytes: readInteger(value?.unpackedBytes),
  };
}

function readCleanInstalledSize(
  value: Record<string, unknown> | undefined,
): NonNullable<PackageSize['cleanInstalled']> {
  return {
    packageBytes: readInteger(value?.packageBytes),
    files: readInteger(value?.files),
  };
}

function readBundledSize(
  value: Record<string, unknown> | undefined,
): NonNullable<PackageSize['bundled']> {
  return {
    rawBytes: readInteger(value?.rawBytes),
    gzipBytes: readInteger(value?.gzipBytes),
    files: readInteger(value?.files),
  };
}

function removeReport(reportPath: string): void {
  if (fs.existsSync(reportPath)) fs.rmSync(reportPath, { force: true });
}

function readInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid size report value: ${String(value)}`);
  }
  return value as number;
}
