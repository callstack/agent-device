import { AsyncLocalStorage } from 'node:async_hooks';
import { ArchiveBudget } from '../utils/archive-safety.ts';

type ArchiveState = { budget: ArchiveBudget; depth: number };
const ARCHIVE_STATE = new AsyncLocalStorage<ArchiveState>();

export async function withInstallArtifactArchiveScope<T>(action: () => Promise<T>): Promise<T> {
  return await ARCHIVE_STATE.run({ budget: new ArchiveBudget(), depth: 0 }, action);
}

export function installArtifactArchiveBudget(): object | undefined {
  return ARCHIVE_STATE.getStore()?.budget;
}

export function installArtifactArchiveDepth(): number {
  return ARCHIVE_STATE.getStore()?.depth ?? 0;
}

export function noteInstallArtifactArchiveDepth(depth: number): void {
  const state = ARCHIVE_STATE.getStore();
  if (state) state.depth = Math.max(state.depth, depth);
}
