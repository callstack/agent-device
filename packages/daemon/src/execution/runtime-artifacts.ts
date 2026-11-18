import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ArtifactAdapter, TemporaryFile } from '@agent-device/contracts/artifact-adapter';
import { AppError } from '@agent-device/kernel/errors';

/**
 * The one temp-file implementation every daemon route shares: an `agent-device-*` root under the
 * process tmpdir, one file inside, removed with the cleanup. Routes whose policy refuses temp
 * files keep the refusing adapter; routes that opt in (runtime policy's `allowTempFiles`, the
 * screenshot artifact adapter) get this implementation.
 */
export async function createDaemonTempFile(options: {
  prefix: string;
  ext: string;
}): Promise<TemporaryFile> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `${options.prefix}-`));
  return {
    path: path.join(root, `file${options.ext}`),
    visibility: 'internal',
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

export function createUnsupportedArtifactAdapter(
  label: string,
  options: { plural?: boolean } = {},
): ArtifactAdapter {
  const verb = options.plural === true ? 'do' : 'does';
  return {
    resolveInput: async () => {
      throw new AppError('UNSUPPORTED_OPERATION', `${label} ${verb} not resolve input artifacts`);
    },
    reserveOutput: async () => {
      throw new AppError('UNSUPPORTED_OPERATION', `${label} ${verb} not reserve output artifacts`);
    },
    createTempFile: async () => {
      throw new AppError('UNSUPPORTED_OPERATION', `${label} ${verb} not create temporary files`);
    },
  };
}
