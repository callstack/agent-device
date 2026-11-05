import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';

/** One lease retains only its latest artifact's basis, even when materialization paths change. */
export class LimrunSyncCache {
  private directory: string | undefined;
  private pending: Promise<unknown> = Promise.resolve();
  private retired = false;

  async run<Value>(
    installablePath: string,
    platform: 'ios' | 'android',
    sync: (basisCacheDir: string) => Promise<Value>,
    signal?: AbortSignal,
  ): Promise<Value> {
    if (this.retired) {
      throw new AppError('COMMAND_FAILED', 'Limrun app sync session has ended.', {
        reason: 'limrun_app_sync_retired',
      });
    }
    const operation = this.pending.then(async () => {
      signal?.throwIfAborted();
      try {
        this.directory ??= await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-limrun-sync-'));
        signal?.throwIfAborted();
        const result = await sync(this.directory);
        // The SDK overwrites current files but retains files removed from the source artifact.
        const source = await fs.stat(installablePath);
        await pruneBasis(
          this.directory,
          source.isDirectory() ? installablePath : undefined,
          source.isDirectory() ? undefined : path.basename(installablePath),
        );
        return result;
      } catch (error) {
        if (this.directory)
          await fs.rm(this.directory, { recursive: true, force: true }).catch(() => {});
        this.directory = undefined;
        if (error instanceof AppError || (signal?.aborted && error === signal.reason)) throw error;
        throw new AppError(
          'COMMAND_FAILED',
          'Limrun app sync failed.',
          {
            reason: 'limrun_app_sync_failed',
            platform,
            installablePath,
          },
          error,
        );
      }
    });
    this.pending = operation.catch(() => {});
    return await operation;
  }

  async dispose(): Promise<void> {
    this.retired = true;
    await this.pending;
    if (this.directory) await fs.rm(this.directory, { recursive: true, force: true });
    this.directory = undefined;
  }
}

async function pruneBasis(cache: string, source?: string, fileName?: string): Promise<void> {
  for (const entry of await fs.readdir(cache, { withFileTypes: true })) {
    const cached = path.join(cache, entry.name);
    const original = source ? path.join(source, entry.name) : undefined;
    const stat = original
      ? await fs.lstat(original).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        })
      : undefined;
    if (!stat && entry.name !== fileName) {
      await fs.rm(cached, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      if (stat?.isDirectory()) await pruneBasis(cached, original);
      else await fs.rm(cached, { recursive: true, force: true });
    }
  }
}
