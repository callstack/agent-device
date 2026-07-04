import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppleImage, DsymMatch, DsymSlice } from './types.ts';
import { normalizeUuid, unique } from './utils.ts';
import { requireExecSuccess, runCmd } from '../../../../utils/exec.ts';
import { AppError } from '../../../../kernel/errors.ts';

const MAX_SEARCH_ENTRIES = 10_000;
const MAX_DSYM_CANDIDATES = 200;
const UUID_DETAIL_SAMPLE_LIMIT = 5;

export async function readDsymPaths(options: {
  cwd: string;
  dsym?: string;
  searchPath?: string;
}): Promise<string[]> {
  if (options.dsym && options.searchPath) {
    return [
      resolvePath(options.cwd, options.dsym),
      ...(await findDsymBundles(resolvePath(options.cwd, options.searchPath))),
    ];
  }
  if (options.dsym) return [resolvePath(options.cwd, options.dsym)];
  if (options.searchPath)
    return await findDsymBundles(resolvePath(options.cwd, options.searchPath));
  return [];
}

async function findDsymBundles(root: string): Promise<string[]> {
  const found: string[] = [];
  let visited = 0;
  async function walk(current: string): Promise<void> {
    if (found.length >= MAX_DSYM_CANDIDATES) return;
    visited += 1;
    if (visited > MAX_SEARCH_ENTRIES) {
      throw new AppError('COMMAND_FAILED', 'debug symbols search-path scan exceeded bounds.', {
        searchPath: root,
        maxEntries: MAX_SEARCH_ENTRIES,
        hint: 'Pass --dsym <App.dSYM> directly or narrow --search-path to the build products directory.',
      });
    }
    const stat = await readSearchPathStat(current, root);
    if (!stat.isDirectory()) {
      if (current === root) throwInvalidSearchPathDirectory(root);
      return;
    }
    if (current.endsWith('.dSYM')) {
      found.push(current);
      return;
    }
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      await walk(path.join(current, entry.name));
    }
  }
  await walk(root);
  return found;
}

async function readSearchPathStat(
  current: string,
  root: string,
): Promise<Awaited<ReturnType<typeof fs.stat>>> {
  try {
    return await fs.stat(current);
  } catch {
    throw new AppError('INVALID_ARGS', `debug symbols search path does not exist: ${root}`, {
      hint: 'Pass an existing build products directory to --search-path, or pass --dsym <App.dSYM> directly.',
    });
  }
}

function throwInvalidSearchPathDirectory(root: string): never {
  throw new AppError('INVALID_ARGS', `debug symbols search path is not a directory: ${root}`, {
    hint: 'Pass an existing build products directory to --search-path, or pass --dsym <App.dSYM> directly.',
  });
}

export async function readDsymSlices(dsymPaths: string[], dwarfdump: string): Promise<DsymSlice[]> {
  const sliceGroups = await Promise.all(
    unique(dsymPaths).map((dsymPath) => readDsymBundleSlices(dsymPath, dwarfdump)),
  );
  const slices = sliceGroups.flat();
  if (slices.length === 0) {
    throw new AppError('COMMAND_FAILED', 'No UUIDs found in dSYM bundle.', {
      hint: 'Verify the path points to a built .dSYM bundle with DWARF contents.',
    });
  }
  return slices;
}

async function readDsymBundleSlices(dsymPath: string, dwarfdump: string): Promise<DsymSlice[]> {
  await assertDsymBundlePath(dsymPath);
  const result = requireExecSuccess(
    await runCmd(dwarfdump, ['--uuid', dsymPath], {
      timeoutMs: 15_000,
      allowFailure: true,
    }),
    `Failed to inspect dSYM UUIDs: ${dsymPath}`,
    { hint: 'Verify the dSYM bundle is valid and readable.' },
  );
  return parseDwarfdumpUuidOutput(dsymPath, result.stdout);
}

async function assertDsymBundlePath(dsymPath: string): Promise<void> {
  const stat = await fs.stat(dsymPath).catch(() => null);
  if (stat?.isDirectory() && dsymPath.endsWith('.dSYM')) return;
  throw new AppError('INVALID_ARGS', `Not a .dSYM bundle: ${dsymPath}`, {
    hint: 'Pass the .dSYM bundle path, not the DWARF executable inside it.',
  });
}

function parseDwarfdumpUuidOutput(dsymPath: string, output: string): DsymSlice[] {
  return output.split('\n').flatMap((line) => {
    const match = line.match(/^UUID:\s+([0-9a-fA-F-]{32,36})\s+\(([^)]+)\)\s+(.+)$/);
    const uuid = normalizeUuid(match?.[1]);
    return match && uuid ? [{ dsymPath, uuid, arch: match[2], binaryPath: match[3]!.trim() }] : [];
  });
}

export function matchImagesToDsyms(
  images: AppleImage[],
  dsymSlices: DsymSlice[],
  explicitDsym: boolean,
): Map<string, DsymMatch> {
  const matched = new Map<string, DsymMatch>();
  for (const image of images) {
    const dsym = dsymSlices.find(
      (candidate) =>
        candidate.uuid === image.uuid &&
        (image.arch === undefined || candidate.arch === undefined || candidate.arch === image.arch),
    );
    if (dsym) matched.set(image.uuid, { image, dsym });
  }
  if (matched.size > 0) return matched;

  const artifactUuids = unique(images.map((image) => image.uuid));
  const dsymUuids = unique(dsymSlices.map((slice) => slice.uuid));
  throw new AppError(
    'COMMAND_FAILED',
    explicitDsym
      ? 'dSYM UUID does not match any Apple image in the crash artifact.'
      : 'No matching dSYM UUID found under search path.',
    {
      artifactUuidCount: artifactUuids.length,
      artifactUuidSample: artifactUuids.slice(0, UUID_DETAIL_SAMPLE_LIMIT),
      dsymUuidCount: dsymUuids.length,
      dsymUuidSample: dsymUuids.slice(0, UUID_DETAIL_SAMPLE_LIMIT),
      hint: 'Use dwarfdump --uuid <App.dSYM> and compare it with the crash Binary Images or usedImages UUID, then pass the matching dSYM/search path.',
    },
  );
}

function resolvePath(cwd: string, value: string): string {
  return path.resolve(cwd, value);
}
