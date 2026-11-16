import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Through the public module, so a test that stubs `runCmd` there also stubs the pack.
import { runCmd } from './command.ts';

export type GzipTarPackOptions = Readonly<{
  /** The host environment `tar` runs with. */
  env: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** The archive's file name; `<directory name>.tar.gz` when omitted. */
  fileName?: string;
}>;

export type PackedGzipTar = Readonly<{
  archivePath: string;
  /** Removes the archive and its temporary directory. Safe to call more than once. */
  cleanup(): void;
}>;

/**
 * Packs a directory, such as a simulator `.app`, into a gzip tar in a fresh temporary directory, for
 * upload or download. The archive holds the directory itself as its one top-level entry. On failure
 * nothing is left behind.
 */
export async function packGzipTar(
  directory: string,
  options: GzipTarPackOptions,
): Promise<PackedGzipTar> {
  options.signal?.throwIfAborted();
  const name = path.basename(directory);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-device-pack-${randomUUID()}-`));
  const cleanup = () => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
  };
  const archivePath = path.join(tempDir, options.fileName ?? `${name}.tar.gz`);
  try {
    // `--` keeps a directory name that starts with `-` from being read as an option.
    await runCmd('tar', ['czf', archivePath, '-C', path.dirname(directory), '--', name], {
      // Keeps macOS tar from adding AppleDouble `._` entries.
      env: { ...options.env, COPYFILE_DISABLE: '1' },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    options.signal?.throwIfAborted();
  } catch (error) {
    cleanup();
    throw error;
  }
  return { archivePath, cleanup };
}
