import type { DeviceInfo } from '@agent-device/kernel/device';
import { runCmdBackground, type ExecBackgroundResult } from '../../../../utils/exec.ts';
import { resolveRunnerDestination } from '../apple-runner-platform.ts';
import { resolveRunnerMaxConcurrentDestinationsFlag } from './runner-cache-metadata.ts';
import { logChunk } from './runner-io.ts';
import { createRunnerListenerReadySignal } from './runner-listener-ready.ts';

const RUNNER_DESTINATION_TIMEOUT_SECONDS = 20;

type LaunchRunnerProcessInput = Readonly<{
  device: DeviceInfo;
  port: number;
  xctestrunPath: string;
  derivedPath: string;
  signal?: AbortSignal;
  logPath?: string;
  traceLogPath?: string;
  verbose?: boolean;
}>;

export type LaunchedRunnerProcess = ExecBackgroundResult &
  Readonly<{ startupRetryWake: AbortSignal }>;

/** Launches xcodebuild and projects its authoritative listener-ready marker as a host signal. */
export function launchRunnerProcess(input: LaunchRunnerProcessInput): LaunchedRunnerProcess {
  const listenerReady = createRunnerListenerReadySignal();
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
    },
  );
  const observeOutput = (source: 'stdout' | 'stderr', chunk: string): void => {
    listenerReady.observe(source, chunk);
    logChunk(chunk, input.logPath, input.traceLogPath, input.verbose);
  };
  launched.child.stdout?.on('data', (chunk: string) => observeOutput('stdout', chunk));
  launched.child.stderr?.on('data', (chunk: string) => observeOutput('stderr', chunk));
  void launched.wait.then(listenerReady.finish, listenerReady.finish);
  return { ...launched, startupRetryWake: listenerReady.wake };
}
