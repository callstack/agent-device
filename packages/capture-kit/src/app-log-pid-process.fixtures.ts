import { vi } from 'vitest';
import type { AppLogBackgroundProcess } from '@agent-device/contracts/app-log-runtime';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export function processFixture(
  wait: ReturnType<typeof deferred<{ stdout: string; stderr: string; exitCode: number }>>,
) {
  const terminate = vi.fn(async () => wait.resolve({ stdout: '', stderr: '', exitCode: 0 }));
  const dispose = vi.fn(async () => {});
  return {
    terminate,
    dispose,
    process: {
      wait: wait.promise,
      terminate,
      [Symbol.asyncDispose]: dispose,
    } satisfies AppLogBackgroundProcess,
  };
}

export function controlledSleeps() {
  const releases: (() => void)[] = [];
  const sleep = (_milliseconds: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const release = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        const index = releases.indexOf(release);
        if (index >= 0) releases.splice(index, 1);
        reject(signal?.reason);
      };
      releases.push(release);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  return {
    sleep,
    pending: () => releases.length,
    releaseNext: () => releases.shift()?.(),
  };
}
