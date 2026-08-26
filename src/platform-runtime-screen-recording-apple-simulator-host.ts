import fs from 'node:fs';
import type {
  HostCommandResult,
  ManagedProcessIdentity,
} from '@agent-device/contracts/platform-runtime-host';
import type { ScreenRecordingBackgroundProcess } from '@agent-device/contracts/screen-recording-runtime-host';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AppleSimulatorScreenRecordingProcess } from './platform-runtime-screen-recording-apple-transport.ts';
import {
  inspectManagedProcess,
  resolveManagedProcessIdentity,
  resolveManagedProcessTree,
  terminateManagedProcessSet,
  type ManagedProcessCommandMatcher,
} from './platform-runtime-screen-recording-process-host.ts';

const READY_POLL_MS = 250;
const LIVENESS_GRACE_MS = 50;
const READY_TIMEOUT_MS = 15_000;
const IDENTITY_POLL_MS = 25;
const IDENTITY_TIMEOUT_MS = 2_000;

const appleSimulatorRecordingCommandMatches: ManagedProcessCommandMatcher = (
  persisted,
  observed,
) => {
  if (persisted === observed) return true;
  const xcrunArgs = /^(?:\S*\/)?xcrun simctl (.+)$/.exec(persisted)?.[1];
  const simctlArgs = /^(?:\S*\/)?simctl (.+)$/.exec(observed)?.[1];
  return (
    xcrunArgs !== undefined &&
    xcrunArgs === simctlArgs &&
    /^(?:--set .+ )?io \S+ recordVideo .+$/.test(xcrunArgs)
  );
};

type AppleSimulatorExit =
  | Readonly<{ kind: 'exited'; result: HostCommandResult }>
  | Readonly<{ kind: 'failed'; error: unknown }>;

export async function startAppleSimulatorRecording(
  device: DeviceInfo,
  outputPath: string,
  signal?: AbortSignal,
): Promise<ScreenRecordingBackgroundProcess> {
  const { resolveAppleSimulatorScreenRecordingTransport } =
    await import('./platform-runtime-screen-recording-apple-transport.ts');
  signal?.throwIfAborted();
  let background: AppleSimulatorScreenRecordingProcess | undefined;
  try {
    background = await acquireSimulatorProcess(
      resolveAppleSimulatorScreenRecordingTransport().start({ device, outputPath, signal }),
      signal,
    );
    signal?.throwIfAborted();
  } catch (error) {
    if (background) await rollbackAcquiredSimulatorProcess(background);
    fs.rmSync(outputPath, { force: true });
    signal?.throwIfAborted();
    throw error;
  }
  if (!background) throw new Error('simctl recordVideo acquisition did not return a process');
  let rootMarker: ManagedProcessIdentity | undefined;
  try {
    rootMarker = await waitForManagedProcessIdentity(background.child.pid, signal);
    if (!rootMarker) {
      throw new Error('simctl recordVideo did not expose a complete process identity');
    }
  } catch (error) {
    background.child.kill('SIGKILL');
    await background.wait.catch(() => undefined);
    signal?.throwIfAborted();
    throw error;
  }
  try {
    await waitForReadiness(outputPath, background.wait, signal);
    // `runCmdBackground('xcrun', ...)` may briefly expose its shell wrapper before that
    // process execs CoreSimulator's `simctl`. Read the root identity again after the output
    // proves the recorder is ready so the durable descriptor and generic startup reaper share
    // the stable post-exec identity already used by the live Apple matcher.
    const postExecRootMarker = (await resolveManagedProcessIdentity(rootMarker.pid)) ?? rootMarker;
    const markers = await resolveManagedProcessTree(postExecRootMarker);
    return createAppleSimulatorProcess(background, markers);
  } catch (error) {
    await terminateManagedProcessSet(
      [rootMarker],
      background,
      appleSimulatorRecordingCommandMatches,
    ).catch(() => {});
    await background.wait.catch(() => undefined);
    fs.rmSync(outputPath, { force: true });
    signal?.throwIfAborted();
    throw error;
  }
}

async function waitForManagedProcessIdentity(
  pid: number | undefined,
  signal?: AbortSignal,
): Promise<ManagedProcessIdentity | undefined> {
  if (pid === undefined) return undefined;
  const attempts = Math.ceil(IDENTITY_TIMEOUT_MS / IDENTITY_POLL_MS);
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    signal?.throwIfAborted();
    const marker = await resolveManagedProcessIdentity(pid);
    if (marker) return marker;
    if (attempt < attempts) await delay(IDENTITY_POLL_MS, signal);
  }
  return undefined;
}

async function acquireSimulatorProcess(
  acquisition: AppleSimulatorScreenRecordingProcess | Promise<AppleSimulatorScreenRecordingProcess>,
  signal?: AbortSignal,
): Promise<AppleSimulatorScreenRecordingProcess> {
  const started = Promise.resolve(acquisition);
  if (!signal) return await started;
  if (signal.aborted) {
    if (isSimulatorProcess(acquisition)) {
      await rollbackAcquiredSimulatorProcess(acquisition);
    } else {
      void started.then(rollbackAcquiredSimulatorProcess);
    }
    throw signal.reason;
  }
  let removeAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbort = () => signal.removeEventListener('abort', onAbort);
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([started, aborted]);
  } catch (error) {
    if (!signal.aborted) throw error;
    void started.then(rollbackAcquiredSimulatorProcess);
    throw signal.reason;
  } finally {
    removeAbort();
  }
}

function isSimulatorProcess(
  value: AppleSimulatorScreenRecordingProcess | Promise<AppleSimulatorScreenRecordingProcess>,
): value is AppleSimulatorScreenRecordingProcess {
  return 'child' in value;
}

async function rollbackAcquiredSimulatorProcess(
  process: AppleSimulatorScreenRecordingProcess,
): Promise<void> {
  process.child.kill('SIGKILL');
  await process.wait.catch(() => undefined);
}

function createAppleSimulatorProcess(
  background: AppleSimulatorScreenRecordingProcess,
  markers: readonly ManagedProcessIdentity[],
): ScreenRecordingBackgroundProcess {
  let termination: Promise<void> | undefined;
  let terminatedByOwner = false;
  const terminate = () =>
    (termination ??= terminateManagedProcessSet(
      markers,
      background,
      appleSimulatorRecordingCommandMatches,
    ).then((outcome) => {
      if (outcome === 'ownership-lost') {
        throw new Error('simctl recordVideo process ownership changed before cleanup');
      }
      if (outcome !== 'terminated' && outcome !== 'already-missing') {
        throw new Error('simctl recordVideo cleanup was not confirmed');
      }
      terminatedByOwner = outcome === 'terminated';
    }));
  const wait = background.wait.then(async (result) => {
    const ownerTermination = termination;
    if (ownerTermination) await ownerTermination.catch(() => undefined);
    return terminatedByOwner && result.exitCode !== 0 ? { ...result, exitCode: 0 } : result;
  });
  return Object.freeze({
    markers: Object.freeze([...markers]),
    wait,
    terminate,
  });
}

export function inspectAppleSimulatorRecordingProcess(marker: ManagedProcessIdentity) {
  return inspectManagedProcess(marker, appleSimulatorRecordingCommandMatches);
}

export async function terminateAppleSimulatorRecordingProcess(marker: ManagedProcessIdentity) {
  return await terminateManagedProcessSet(
    [marker],
    undefined,
    appleSimulatorRecordingCommandMatches,
  );
}

async function waitForReadiness(
  outputPath: string,
  wait: Promise<HostCommandResult>,
  signal?: AbortSignal,
): Promise<void> {
  const processExit = wait.then(
    (result) => ({ kind: 'exited' as const, result }),
    (error: unknown) => ({ kind: 'failed' as const, error }),
  );
  let settled: AppleSimulatorExit | undefined;
  void processExit.then((outcome) => {
    settled = outcome;
  });
  await Promise.resolve();
  const attempts = Math.ceil(READY_TIMEOUT_MS / READY_POLL_MS);
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    signal?.throwIfAborted();
    if (settled) throw startError(settled);
    if (fs.existsSync(outputPath)) {
      const exit = await Promise.race([
        processExit,
        delay(LIVENESS_GRACE_MS, signal).then(() => undefined),
      ]);
      if (exit) throw startError(exit);
      return;
    }
    if (attempt === attempts) {
      throw new Error(`simctl recordVideo did not create its output within ${READY_TIMEOUT_MS}ms`);
    }
    const exit = await Promise.race([
      processExit,
      delay(READY_POLL_MS, signal).then(() => undefined),
    ]);
    if (exit) throw startError(exit);
  }
}

function startError(outcome: AppleSimulatorExit): Error {
  if (outcome.kind === 'failed') {
    return outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
  }
  return new Error(`simctl recordVideo exited with code ${outcome.result.exitCode}`);
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const timer = setTimeout(() => finish(), milliseconds);
    if (!signal) return;
    const onAbort = () => finish(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
