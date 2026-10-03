import fs from 'node:fs';
import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { runCmdBackground } from './host.ts';
import type { ExecBackgroundResult } from '@agent-device/host-kit/command';
import { resolveRunnerDestination } from './apple-runner-platform.ts';
import { resolveRunnerMaxConcurrentDestinationsFlag } from './runner-cache-metadata.ts';
import { xcodebuildDestinationArgs } from './runner-device-set.ts';
import {
  createRunnerLogFile,
  logChunk,
  readRunnerLogTail,
  tailRunnerLogFile,
} from './runner-io.ts';
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
    /** Gives up this process's sides of the runner's log; see {@link launchRunnerProcess}. */
    endOutputObservation: () => void;
    /** Reads the end of the runner's log, which the runner itself keeps writing to (#2681). */
    readLogTail(maxBytes: number): string;
  }>;

/**
 * Launches xcodebuild and projects its authoritative listener-ready marker as a host signal.
 *
 * The runner's stdout/stderr are this file, not pipes: a detached runner outlives the daemon that
 * started it, and a pipe hands it a reader whose death raises SIGPIPE on the runner's next write,
 * minutes into the next daemon's session (#2681). Readiness is projected from that same file, so the
 * marker still wakes startup retries, and process exit still wakes them on its own.
 */
export function launchRunnerProcess(input: LaunchRunnerProcessInput): LaunchedRunnerProcess {
  const logPath = input.logPath;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const outputFd = fs.openSync(logPath, 'a');
  // An append descriptor opens at end-of-file, so the size behind it is where this generation's
  // output starts. It is read here rather than after the spawn because a runner that dies
  // immediately writes its failure into exactly this window: bytes landed during the spawn would
  // otherwise sit below the offset and reach neither the readiness tail nor an error's quote.
  const logFile = createRunnerLogFile(logPath, outputFd);
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
        ...xcodebuildDestinationArgs(input.device, resolveRunnerDestination(input.device)),
      ],
      {
        allowFailure: true,
        // xcodebuild does not forward its own environment to the test runner: per xcodebuild(1),
        // only names prefixed `TEST_RUNNER_` cross that boundary, with the prefix stripped. This
        // entry is visible to xcodebuild alone, and the runner reads its port from the session
        // xctestrun's EnvironmentVariables instead.
        env: { ...process.env, AGENT_DEVICE_RUNNER_PORT: String(input.port) },
        detached: true,
        signal: input.signal,
        stdio: ['ignore', outputFd, outputFd],
        captureOutput: false,
      },
    );
    const logTail = tailRunnerLogFile({
      file: logFile,
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
      endOutputObservation,
      readLogTail: (maxBytes) => readRunnerLogTail(logFile, maxBytes),
    };
  } catch (error) {
    closeOutputFd();
    throw error;
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
