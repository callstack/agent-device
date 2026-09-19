import type { AppLogRuntimeHost } from '@agent-device/contracts/app-log-runtime';

export type DeferredSleeps = Readonly<{
  wait(milliseconds: number): Promise<void>;
  resolveNext(milliseconds: number): void;
  resolveAny(): void;
  hasPending(milliseconds: number): boolean;
}>;

export function createDeferredSleeps(): DeferredSleeps {
  const pending: Array<{ milliseconds: number; resolve: () => void }> = [];
  return {
    wait: async (milliseconds: number) =>
      await new Promise<void>((resolve) => pending.push({ milliseconds, resolve })),
    resolveNext: (milliseconds: number) => {
      const index = pending.findIndex((entry) => entry.milliseconds === milliseconds);
      if (index < 0) throw new Error(`No ${milliseconds}ms sleep is pending`);
      pending.splice(index, 1)[0]?.resolve();
    },
    resolveAny: () => pending.shift()?.resolve(),
    hasPending: (milliseconds: number) =>
      pending.some((entry) => entry.milliseconds === milliseconds),
  };
}

export function createPollerHost(options: {
  existingTail: string;
  writes: string[];
  sleeps: DeferredSleeps;
  onOutputDispose?: () => void;
  outputDisposeError?: boolean;
  failure?: 'readTail' | 'openAppend';
}): AppLogRuntimeHost {
  return {
    appleTools: {
      isXcrunAvailable: async () => false,
      run: async () => {
        throw new Error('unused');
      },
    },
    toolchains: { prepare: async () => undefined },
    artifacts: {
      resolveSession: () => ({
        outputPath: '/sessions/one/app.log',
        pidPath: '/sessions/one/app-log.pid',
      }),
    },
    commands: {
      which: async () => undefined,
      run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    },
    outputs: {
      readTail: async () => {
        if (options.failure === 'readTail') throw new Error('tail failed');
        return options.existingTail;
      },
      openAppend: async () => {
        if (options.failure === 'openAppend') throw new Error('open failed');
        return {
          write: async (chunk) => {
            options.writes.push(String(chunk));
          },
          [Symbol.asyncDispose]: async () => {
            if (options.outputDisposeError) throw new Error('output cleanup failed');
            options.onOutputDispose?.();
          },
        };
      },
    },
    processTransports: {
      resolve: async () => ({ mode: 'local' }),
    },
    processes: {
      start: async () => {
        throw new Error('unused');
      },
      readMarker: async () => ({ status: 'missing' }),
      clearMarker: async () => {},
      inspect: async () => 'missing',
      terminate: async () => 'already-missing',
    },
    clock: {
      now: () => 100,
      sleep: async (milliseconds) => await options.sleeps.wait(milliseconds),
    },
  };
}
