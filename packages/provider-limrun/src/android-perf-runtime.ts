import type { PerfRuntimeOperations } from '@agent-device/contracts/perf-runtime';
import { AppError } from '@agent-device/kernel/errors';

export type LimrunAndroidPerfOperations = Pick<
  PerfRuntimeOperations,
  'perfFrames' | 'perfMemorySample' | 'perfMemorySnapshot'
>;

export function createLimrunAndroidPerfOperations(
  bind: () => Promise<LimrunAndroidPerfOperations | undefined>,
  signal: AbortSignal,
): LimrunAndroidPerfOperations {
  const load = async () => {
    signal.throwIfAborted();
    const operations = await bind();
    signal.throwIfAborted();
    if (!operations)
      throw new AppError('DEVICE_NOT_FOUND', 'Limrun Android session is unavailable');
    return operations;
  };
  return {
    perfFrames: async (input) => (await load()).perfFrames(input),
    perfMemorySample: async (input) => (await load()).perfMemorySample(input),
    perfMemorySnapshot: async (input) => (await load()).perfMemorySnapshot(input),
  };
}
