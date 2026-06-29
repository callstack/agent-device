import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../kernel/errors.ts';

const DEFAULT_MATERIALIZED_PATH_TTL_MS = 15 * 60 * 1000;

type RetainedEntry = {
  rootPath: string;
  installablePath: string;
  archivePath?: string;
  tenantId?: string;
  sessionName?: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
};

export type RetainedMaterializedPaths = {
  materializationId: string;
  installablePath: string;
  archivePath?: string;
  expiresAt: string;
};

const retainedPaths = new Map<string, RetainedEntry>();

export async function retainMaterializedPaths(params: {
  installablePath: string;
  archivePath?: string;
  tenantId?: string;
  sessionName?: string;
  ttlMs?: number;
}): Promise<RetainedMaterializedPaths> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-materialized-'));
  try {
    const retainedInstallablePath = await copyPathInto(
      params.installablePath,
      path.join(rootPath, 'installable'),
    );
    const retainedArchivePath = params.archivePath
      ? await copyPathInto(params.archivePath, path.join(rootPath, 'archive'))
      : undefined;
    const materializationId = crypto.randomUUID();
    const ttlMs = params.ttlMs ?? DEFAULT_MATERIALIZED_PATH_TTL_MS;
    const expiresAt = Date.now() + ttlMs;
    const timer = setTimeout(() => {
      void cleanupRetainedMaterializedPaths(materializationId);
    }, ttlMs);
    retainedPaths.set(materializationId, {
      rootPath,
      installablePath: retainedInstallablePath,
      archivePath: retainedArchivePath,
      tenantId: params.tenantId,
      sessionName: params.sessionName,
      expiresAt,
      timer,
    });
    return {
      materializationId,
      installablePath: retainedInstallablePath,
      ...(retainedArchivePath ? { archivePath: retainedArchivePath } : {}),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  } catch (error) {
    await fs.rm(rootPath, { recursive: true, force: true });
    throw error;
  }
}

export async function cleanupRetainedMaterializedPaths(
  materializationId: string,
  tenantId?: string,
): Promise<void> {
  const entry = retainedPaths.get(materializationId);
  if (!entry) {
    throw new AppError('INVALID_ARGS', `Materialized paths not found: ${materializationId}`);
  }
  if (entry.tenantId && entry.tenantId !== tenantId) {
    throw new AppError('UNAUTHORIZED', 'Materialized paths belong to a different tenant');
  }
  clearTimeout(entry.timer);
  retainedPaths.delete(materializationId);
  await fs.rm(entry.rootPath, { recursive: true, force: true });
}

export async function cleanupRetainedMaterializedPathsForSession(
  sessionName: string,
): Promise<void> {
  const matchingIds = Array.from(retainedPaths.entries())
    .filter(([, entry]) => entry.sessionName === sessionName)
    .map(([materializationId]) => materializationId);
  await Promise.all(
    matchingIds.map(async (materializationId) => {
      await cleanupRetainedMaterializedPaths(materializationId);
    }),
  );
}

async function copyPathInto(sourcePath: string, parentDir: string): Promise<string> {
  const stat = await fs.stat(sourcePath);
  await fs.mkdir(parentDir, { recursive: true });
  const destinationPath = path.join(parentDir, path.basename(sourcePath));
  if (stat.isDirectory()) {
    await fs.cp(sourcePath, destinationPath, { recursive: true });
    return destinationPath;
  }
  await fs.copyFile(sourcePath, destinationPath);
  return destinationPath;
}
