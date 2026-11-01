import assert from 'node:assert/strict';

/**
 * Collects the rejections the process would die on: the daemon's failure mode for one is to take every other
 * session down with it. The check yields to a macrotask first, because Node reports a rejection only after the
 * current microtask drain — asserting before that yield, or removing the listener without one, could pass a
 * leaked rejection unseen.
 */
export function watchUnhandledRejections(): {
  assertIsSilent: () => Promise<void>;
  stop: () => void;
} {
  const seen: unknown[] = [];
  const watch = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on('unhandledRejection', watch);
  return {
    assertIsSilent: async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      if (seen.length > 0) assert.fail(`expected no unhandled rejection, got ${String(seen[0])}`);
    },
    stop: () => process.off('unhandledRejection', watch),
  };
}
