import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { requireTenantOwnedEntry, type TenantOwnedResourceKind } from './tenant-owned-entry.ts';

const DEFAULT_MATERIALIZED_PATH_TTL_MS = 15 * 60 * 1000;

const MATERIALIZED_PATHS_RESOURCE: TenantOwnedResourceKind = {
  label: 'Materialized paths',
  plural: true,
  expiredHint:
    'Materialized paths are released automatically when their TTL expires; re-run the command that materialized them if the paths are still needed.',
};

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
      void expireRetainedMaterializedPaths(materializationId);
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
  const entry = requireTenantOwnedEntry(
    retainedPaths,
    materializationId,
    tenantId,
    MATERIALIZED_PATHS_RESOURCE,
  );
  await removeRetainedEntry(materializationId, entry);
}

export async function cleanupRetainedMaterializedPathsForSession(
  sessionName: string,
): Promise<void> {
  const matchingEntries = Array.from(retainedPaths.entries()).filter(
    ([, entry]) => entry.sessionName === sessionName,
  );
  await Promise.all(
    matchingEntries.map(async ([materializationId, entry]) => {
      await removeRetainedEntry(materializationId, entry);
    }),
  );
}

// Daemon-internal expiry: skips the tenant check (the timer has no tenant
// context) and must never reject — the caller is a bare setTimeout.
async function expireRetainedMaterializedPaths(materializationId: string): Promise<void> {
  const entry = retainedPaths.get(materializationId);
  if (!entry) return;
  try {
    await removeRetainedEntry(materializationId, entry);
  } catch {
    // best-effort cleanup only
  }
}

async function removeRetainedEntry(materializationId: string, entry: RetainedEntry): Promise<void> {
  clearTimeout(entry.timer);
  retainedPaths.delete(materializationId);
  await fs.rm(entry.rootPath, { recursive: true, force: true });
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
