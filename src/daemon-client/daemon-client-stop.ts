import {
  daemonShutdownCompletionAnswers,
  readDaemonShutdownRecord,
  readDaemonShutdownReport,
  type DaemonShutdownRecord,
  type DaemonShutdownCompletionQuery,
} from '@agent-device/daemon-contracts/daemon-shutdown-report';
import { waitForDaemonExit } from '@agent-device/daemon-contracts/daemon-process';
import {
  DAEMON_LIFECYCLE_REASONS,
  readDaemonLifecycleCensus,
  type DaemonPaths,
} from '@agent-device/daemon-contracts/daemon-resolution';
import type { DaemonStopIdentity } from '@agent-device/daemon-contracts/daemon-registration';
import {
  daemonNotRunningStopResult,
  stopDaemon,
  mergeDaemonShutdownReport,
  type DaemonStopResult,
} from '@agent-device/daemon-contracts/daemon-stop';
import { AppError } from '@agent-device/kernel/errors';
import { sleep } from '@agent-device/host-kit/retry';
import { daemonInfoFromRecord, type DaemonInfo } from './daemon-client-metadata.ts';
import {
  DAEMON_LEAVE_WAIT_MS,
  requestDaemonLifecycle,
  type DaemonLifecycleTarget,
} from './daemon-client-lifecycle-request.ts';

const EMBEDDED_STOP_ASK_BUDGET_MS = 5_000;
const EMBEDDED_STOP_ASK_GAP_MS = 250;
const EMBEDDED_STOP_POLL_MS = 100;
const EMBEDDED_STOP_LIFETIME_POLL_MS = 1_000;

export async function stopRecordedDaemon(
  record: DaemonStopIdentity,
  target: DaemonLifecycleTarget,
): Promise<DaemonStopResult> {
  if (record.ownership === 'unreadable') throw daemonRecordUnreadableError(target.paths);
  if (record.ownership === 'embedded' || record.ownership === 'unknown') {
    const info = record.record && daemonInfoFromRecord(record.record);
    if (!info) throw daemonEmbeddedRecordUnaddressableError(target.paths);
    return await stopEmbeddedDaemon(info, target);
  }
  const observed = record.identity ? { ...record.identity, ownership: 'detached' as const } : null;
  const stopped = await stopDaemon({ paths: target.paths, observed });
  return mergeDaemonShutdownReport(
    stopped,
    stopped.mode === 'graceful' ? readDaemonShutdownReport(target.paths.baseDir) : null,
  );
}

function daemonRecordUnreadableError(paths: DaemonPaths): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `The daemon record on ${paths.baseDir} cannot be read, so this stop cannot tell whether a daemon runs.`,
    {
      reason: 'daemon-record-unreadable',
      stateDir: paths.baseDir,
      hint: 'Nothing was signaled. Inspect or remove that record, then retry.',
    },
  );
}

async function stopEmbeddedDaemon(
  info: DaemonInfo,
  target: DaemonLifecycleTarget,
): Promise<DaemonStopResult> {
  const instance = {
    pid: info.pid,
    processStartTime: info.processStartTime ?? '',
    token: info.token,
  };
  const deadlineMs = Date.now() + DAEMON_LEAVE_WAIT_MS;
  const early = await askToLeave(info, target, instance);
  if (early?.completion?.outcome === 'retained' && (await instanceEnded(instance)))
    return daemonNotRunningStopResult();
  const waited = early ?? (await waitForClose(target.paths, instance, deadlineMs));
  if (waited === 'instance-gone') return daemonNotRunningStopResult();
  if (!waited) throw daemonShutdownUnconfirmedError(info, target.paths);
  return stopResultFromCompletion(waited);
}

async function askToLeave(
  info: DaemonInfo,
  target: DaemonLifecycleTarget,
  instance: DaemonShutdownCompletionQuery,
): Promise<DaemonShutdownRecord | null> {
  const askUntilMs = Date.now() + EMBEDDED_STOP_ASK_BUDGET_MS;
  for (;;) {
    const record = readDaemonShutdownRecord(target.paths.baseDir);
    if (record.completion && daemonShutdownCompletionAnswers(record.completion, instance))
      return record;
    try {
      const asked = await requestDaemonLifecycle(info, target, 'shutdown');
      if (asked.outcome === 'gone' && !instance.processStartTime.trim())
        throw daemonShutdownUnconfirmedError(info, target.paths);
      return null;
    } catch (error) {
      if (!refusedWhileStartingUp(error) || Date.now() >= askUntilMs) throw error;
    }
    await sleep(EMBEDDED_STOP_ASK_GAP_MS);
  }
}

function refusedWhileStartingUp(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.details?.reason === DAEMON_LIFECYCLE_REASONS.busy &&
    readDaemonLifecycleCensus(error.details)?.startingUp === true
  );
}

async function waitForClose(
  paths: DaemonPaths,
  instance: DaemonShutdownCompletionQuery,
  deadlineMs: number,
): Promise<DaemonShutdownRecord | 'instance-gone' | null> {
  let nextLifetimeCheckMs = 0;
  while (Date.now() < deadlineMs) {
    const record = readDaemonShutdownRecord(paths.baseDir);
    const matching =
      record.completion && daemonShutdownCompletionAnswers(record.completion, instance);
    if (matching && record.completion?.outcome === 'released') return record;
    if (Date.now() >= nextLifetimeCheckMs || matching) {
      nextLifetimeCheckMs = Date.now() + EMBEDDED_STOP_LIFETIME_POLL_MS;
      if (await instanceEnded(instance)) return 'instance-gone';
    }
    if (matching) return record;
    await sleep(Math.min(EMBEDDED_STOP_POLL_MS, Math.max(0, deadlineMs - Date.now())));
  }
  return null;
}

async function instanceEnded(instance: DaemonShutdownCompletionQuery): Promise<boolean> {
  if (!instance.processStartTime.trim()) return false;
  const identity = { pid: instance.pid, startTime: instance.processStartTime };
  return (await waitForDaemonExit(identity, { timeoutMs: 0 })).exited;
}

function stopResultFromCompletion(record: DaemonShutdownRecord): DaemonStopResult {
  const completion = record.completion!;
  const released = completion.outcome === 'released';
  return mergeDaemonShutdownReport(
    {
      stopped: true,
      mode: 'graceful',
      cleanupConfidence: released && completion.unfinished.length === 0 ? 'known' : 'unknown',
      claimsReleased: [],
      claimsOrphaned: [],
      claimsSuperseded: [],
      claimsUnattributable: [],
      providerReleases: { status: 'completed', released: [], pending: [] },
      warnings: [
        ...completion.unfinished,
        ...(released
          ? []
          : [
              'The runtime stopped serving and keeps its registration: a host process still owns it, so nothing outside that process may signal it.',
            ]),
      ],
    },
    record.report,
  );
}

function daemonEmbeddedRecordUnaddressableError(paths: DaemonPaths): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `The record on ${paths.baseDir} does not name a transport and a token, so the runtime it describes cannot be reached.`,
    {
      reason: 'daemon-embedded-stop-unreachable',
      stateDir: paths.baseDir,
      record: 'incomplete',
      hint: 'Nothing was signaled. Inspect the record, or close the host that owns this runtime.',
    },
  );
}

function daemonShutdownUnconfirmedError(info: DaemonInfo, paths: DaemonPaths): AppError {
  return new AppError('COMMAND_FAILED', 'The runtime did not report that it finished leaving.', {
    reason: 'daemon-shutdown-unconfirmed',
    pid: info.pid,
    ...(info.processStartTime ? { processStartTime: info.processStartTime } : {}),
    stateDir: paths.baseDir,
    hint: 'It was not signaled, and it may still be serving. Ask the host that owns it to close it, or retry the stop.',
  });
}
