import { withCommandExecutorOverride } from '@agent-device/host-kit/command';

export type RecordedSpawn = { command: string; args: readonly string[] };

export type CommandSpawnOutcome = {
  /** Exit status reported for every recorded command. Defaults to success. */
  exitCode?: number;
  /** Report that the binary could not be spawned at all, as a missing launcher does. */
  spawnFails?: boolean;
};

export type CommandSpawnRecorder = {
  readonly spawns: RecordedSpawn[];
  run<T>(fn: () => Promise<T>): Promise<T>;
};

/**
 * Answer every host command the wrapped code spawns and record the argv it was handed, so a test
 * can prove which binary a flow would have run without running anything.
 */
export function recordCommandSpawns(outcome: CommandSpawnOutcome = {}): CommandSpawnRecorder {
  const spawns: RecordedSpawn[] = [];
  return {
    spawns,
    async run<T>(fn: () => Promise<T>): Promise<T> {
      return await withCommandExecutorOverride((command, args) => {
        spawns.push({ command, args });
        return outcome.spawnFails
          ? Promise.reject(new Error(`spawn ${command} ENOENT`))
          : Promise.resolve({ stdout: '', stderr: '', exitCode: outcome.exitCode ?? 0 });
      }, fn);
    },
  };
}

/** Run `fn` with the process claiming to run on `platform`, restoring the real platform after. */
export function withMockedPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const previous = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  return fn().finally(() => {
    Object.defineProperty(process, 'platform', { value: previous, configurable: true });
  });
}
