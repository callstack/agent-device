import fs from 'node:fs/promises';
import path from 'node:path';
import { readAppleCrashArtifact } from './debug-symbols/crash-artifact.ts';
import { matchImagesToDsyms, readDsymPaths, readDsymSlices } from './debug-symbols/dsym.ts';
import { summarizeCrashArtifact } from './debug-symbols/report.ts';
import { resolveAppleTools, symbolicateAddresses } from './debug-symbols/symbolication.ts';
import type { DebugSymbolsOptions, DebugSymbolsResult } from '../../../contracts/debug-symbols.ts';
import { AppError } from '../../../kernel/errors.ts';

const MAX_CRASH_ARTIFACT_BYTES = 64 * 1024 * 1024;

export async function symbolicateCrashArtifact(
  options: DebugSymbolsOptions,
): Promise<DebugSymbolsResult> {
  if (options.action !== undefined && options.action !== 'symbols') {
    throw new AppError('INVALID_ARGS', 'debug supports only the symbols workflow.', {
      hint: 'Use debug symbols --artifact <crash.ips|crash.log> --dsym <App.dSYM> or --search-path <dir> --out <path>.',
    });
  }
  const cwd = options.cwd ?? process.cwd();
  const artifactPath = resolvePath(cwd, options.artifact);
  const outPath = resolvePath(cwd, options.out ?? defaultOutPath(artifactPath));
  const artifactText = await readTextFile(artifactPath, 'crash artifact');
  const crash = readAppleCrashArtifact(artifactText);
  if (!crash) throwUnsupportedArtifact();

  const dsymPaths = await readDsymPaths({
    cwd,
    dsym: options.dsym,
    searchPath: options.searchPath,
  });
  if (dsymPaths.length === 0) {
    throw new AppError('INVALID_ARGS', 'debug symbols requires --dsym or --search-path.', {
      hint: 'Pass a matching .dSYM bundle directly, or pass --search-path <dir> so agent-device can match crash image UUIDs to local dSYMs.',
    });
  }

  const tools = await resolveAppleTools();
  const dsymSlices = await readDsymSlices(dsymPaths, tools.dwarfdump);
  const matched = matchImagesToDsyms(crash.images, dsymSlices, Boolean(options.dsym));
  const addressMap = await symbolicateAddresses(crash.addresses, matched, tools.atos);
  const output = crash.write(addressMap);

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, output, 'utf8');

  const matchedImages = [...matched.values()].map(({ image, dsym }) => ({
    name: image.name,
    uuid: image.uuid,
    arch: image.arch ?? dsym.arch,
    dsymPath: dsym.dsymPath,
    binaryPath: dsym.binaryPath,
  }));
  const symbolicatedFrames = [...addressMap.values()].filter((entry) => entry.text).length;
  const skippedImages = crash.images.length - matchedImages.length;
  const warnings =
    skippedImages > 0
      ? [
          `${skippedImages} Apple image${skippedImages === 1 ? '' : 's'} had no matching dSYM and were left unchanged.`,
        ]
      : undefined;

  return {
    kind: 'debugSymbols',
    platform: 'apple',
    artifactPath,
    outPath,
    crash: summarizeCrashArtifact(crash, addressMap),
    matchedImages,
    symbolicatedFrames,
    skippedImages,
    warnings,
    message: `Symbolicated ${symbolicatedFrames} frame${symbolicatedFrames === 1 ? '' : 's'} -> ${outPath}`,
  };
}

function throwUnsupportedArtifact(): never {
  throw new AppError(
    'UNSUPPORTED_OPERATION',
    'debug symbols currently supports Apple crash artifacts with Binary Images or IPS usedImages.',
    {
      hint: 'For Android Java/R8 crashes, use retrace with mapping.txt. For Android native crashes, use ndk-stack or addr2line with unstripped .so symbols. Capture the crash with logs, then symbolicate externally until Android support is added.',
    },
  );
}

async function readTextFile(filePath: string, label: string): Promise<string> {
  await assertTextFileWithinLimit(filePath, label);
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError('INVALID_ARGS', `Failed to read ${label}: ${filePath}`, { message });
  }
}

async function assertTextFileWithinLimit(filePath: string, label: string): Promise<void> {
  try {
    const stats = await fs.stat(filePath);
    if (stats.size <= MAX_CRASH_ARTIFACT_BYTES) return;
    throw new AppError('INVALID_ARGS', `${label} is too large: ${filePath}`, {
      actualBytes: stats.size,
      maxBytes: MAX_CRASH_ARTIFACT_BYTES,
      hint: 'Pass a bounded Apple .ips/.crash artifact. For very large logs, first narrow the log to the crash report, or use logs grep/tail for lead-up context.',
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError('INVALID_ARGS', `Failed to read ${label}: ${filePath}`, { message });
  }
}

function resolvePath(cwd: string, value: string): string {
  return path.resolve(cwd, value);
}

function defaultOutPath(artifactPath: string): string {
  const extension = path.extname(artifactPath);
  const base = extension ? artifactPath.slice(0, -extension.length) : artifactPath;
  return `${base}-symbolicated${extension || '.log'}`;
}
