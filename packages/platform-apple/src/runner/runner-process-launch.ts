import fs from 'node:fs';
import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { runCmdBackground, type ExecBackgroundResult } from './host.ts';
import { resolveRunnerDestination } from './apple-runner-platform.ts';
import { resolveRunnerMaxConcurrentDestinationsFlag } from './runner-cache-metadata.ts';
import { logChunk, readRunnerLogTail, tailRunnerLogFile } from './runner-io.ts';
import { createRunnerListenerReadySignal } from './runner-listener-ready.ts';

const RUNNER_DESTINATION_TIMEOUT_SECONDS = 20;

type LaunchRunnerProcessInput = Readonly<{
  device: DeviceInfo;
  port: number;
  xctestrunPath: string;
  derivedPath: string;
  /** Where the runner's own output goes. The child owns this file for its whole life (#2681). */
  logPath: string;
  signal?: AbortSignal;
  traceLogPath?: string;
  verbose?: boolean;
}>;

export type LaunchedRunnerProcess = ExecBackgroundResult &
  Readonly<{
    startupRetryWake: AbortSignal;
    runnerLogPath: string;
    /** Gives up this process's sides of the runner's log; see {@link launchRunnerProcess}. */
    endOutputObservation: () => void;
    /** Reads the end of the runner's log, which the runner itself keeps writing to (#2681). */
    readLogTail(maxBytes: number): string;
  }>;

/**
 * Launches xcodebuild and projects its authoritative listener-ready marker as a host signal.
 *
 * The runner's stdout/stderr are this file, not pipes (#2681). A detached runner outlives the daemon
 * that started it, and a pipe hands that runner a reader whose death raises SIGPIPE on the runner's
 * *next* write — which can be minutes into the next daemon's session, nowhere near the handoff that
 * could still have refused it. A regular file has no such reader: the runner keeps appending whether
 * anyone is watching, and the next daemon can read the same file. Readiness is projected from that
 * file, so the marker still wakes startup retries, and process exit still wakes them on its own.
 */
export function launchRunnerProcess(input: LaunchRunnerProcessInput): LaunchedRunnerProcess {
  const logPath = input.logPath;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const outputFd = fs.openSync(logPath, 'a');
  const closeOutputFd = once(() => {
    try {
      fs.closeSync(outputFd);
    } catch {}
  });
  const listenerReady = createRunnerListenerReadySignal();
  try {
    const launched = runCmdBackground(
      'xcodebuild',
      [
        'test-without-building',
        '-only-testing',
        'AgentDeviceRunnerUITests/RunnerTests/testCommand',
        '-parallel-testing-enabled',
        'NO',
        '-test-timeouts-enabled',
        'NO',
        '-collect-test-diagnostics',
        'never',
        resolveRunnerMaxConcurrentDestinationsFlag(input.device),
        '1',
        '-destination-timeout',
        String(RUNNER_DESTINATION_TIMEOUT_SECONDS),
        '-xctestrun',
        input.xctestrunPath,
        '-derivedDataPath',
        input.derivedPath,
        '-destination',
        resolveRunnerDestination(input.device),
      ],
      {
        allowFailure: true,
        env: { ...process.env, AGENT_DEVICE_RUNNER_PORT: String(input.port) },
        detached: true,
        signal: input.signal,
        stdio: ['ignore', outputFd, outputFd],
        captureOutput: false,
      },
    );
    // The append flag already put the write end at end-of-file, so anything the runner logs from
    // here on is this generation's output; whatever was in the file before belongs to an older one.
    const logTail = tailRunnerLogFile({
      logPath,
      offset: currentFileSize(outputFd),
      onOutput: (chunk) => {
        listenerReady.observe(chunk);
        if (input.traceLogPath || input.verbose) {
          logChunk(chunk, undefined, input.traceLogPath, input.verbose);
        }
      },
    });
    const endOutputObservation = once(() => {
      logTail.stop();
      closeOutputFd();
    });
    const onProcessSettled = () => {
      logTail.drain();
      closeOutputFd();
      listenerReady.finish();
    };
    void launched.wait.then(onProcessSettled, onProcessSettled);
    return {
      ...launched,
      startupRetryWake: listenerReady.wake,
      runnerLogPath: logPath,
      endOutputObservation,
      readLogTail: (maxBytes) => readRunnerLogTail(logPath, maxBytes),
    };
  } catch (error) {
    closeOutputFd();
    throw error;
  }
}

function currentFileSize(fd: number): number {
  try {
    return fs.fstatSync(fd).size;
  } catch {
    return 0;
  }
}

function once(task: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    task();
  };
}
