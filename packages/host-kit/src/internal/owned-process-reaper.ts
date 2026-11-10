import type { OwnedProcessRecord } from '@agent-device/contracts/platform-runtime-host';
import { stopProcessAndConfirmExit, type ConfirmedProcessStop } from './host-process.ts';
import type { OwnedProcessRecordRead, OwnedProcessRecordStore } from './owned-process-record.ts';

const DEFAULT_TERM_TIMEOUT_MS = 1_500;
const DEFAULT_KILL_TIMEOUT_MS = 1_000;

export type OwnedProcessReapSummary = Readonly<{
  inspected: number;
  inspectedPids: readonly number[];
  terminated: number;
  terminatedPids: readonly number[];
  missing: number;
  missingPids: readonly number[];
  /** Records kept because the host would not confirm the pid still runs the recorded process. */
  unconfirmed: number;
  unconfirmedPids: readonly number[];
  /** Records kept because the confirmed process outlived SIGKILL or refused the signal. */
  survived: number;
  survivedPids: readonly number[];
  skippedForOpenWebSession: boolean;
}>;

export async function reapOwnedProcessRecordsAtStartup(
  store: OwnedProcessRecordStore,
  options: Readonly<{
    openWebSessionNames?: readonly string[];
    purposes?: readonly string[];
    termTimeoutMs?: number;
    killTimeoutMs?: number;
  }> = {},
): Promise<OwnedProcessReapSummary> {
  const summary = createReapSummary();
  const policy = createReapPolicy(options);
  for (const entry of store.read()) {
    if (!isDecodedRecord(entry)) continue;
    const retained = await reapDecodedEntry(entry, policy, summary);
    if (retained.length === 0) store.clear(entry.scope);
    else if (retained.length !== entry.records.length) store.replace(entry.scope, retained);
  }
  return Object.freeze(summary);
}

function isDecodedRecord(
  entry: OwnedProcessRecordRead,
): entry is OwnedProcessRecordRead & { status: 'decoded' } {
  return entry.status === 'decoded';
}

type MutableReapSummary = {
  inspected: number;
  inspectedPids: number[];
  terminated: number;
  terminatedPids: number[];
  missing: number;
  missingPids: number[];
  unconfirmed: number;
  unconfirmedPids: number[];
  survived: number;
  survivedPids: number[];
  skippedForOpenWebSession: boolean;
};

type ReapPolicy = Readonly<{
  openWebSession: boolean;
  purposes?: ReadonlySet<string>;
  termTimeoutMs: number;
  killTimeoutMs: number;
}>;

function createReapSummary(): MutableReapSummary {
  return {
    inspected: 0,
    inspectedPids: [],
    terminated: 0,
    terminatedPids: [],
    missing: 0,
    missingPids: [],
    unconfirmed: 0,
    unconfirmedPids: [],
    survived: 0,
    survivedPids: [],
    skippedForOpenWebSession: false,
  };
}

function createReapPolicy(options: {
  openWebSessionNames?: readonly string[];
  purposes?: readonly string[];
  termTimeoutMs?: number;
  killTimeoutMs?: number;
}): ReapPolicy {
  return {
    openWebSession: (options.openWebSessionNames ?? []).length > 0,
    purposes: options.purposes ? new Set(options.purposes) : undefined,
    termTimeoutMs: options.termTimeoutMs ?? DEFAULT_TERM_TIMEOUT_MS,
    killTimeoutMs: options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS,
  };
}

async function reapDecodedEntry(
  entry: OwnedProcessRecordRead & { status: 'decoded' },
  policy: ReapPolicy,
  summary: MutableReapSummary,
): Promise<OwnedProcessRecord[]> {
  const retained: OwnedProcessRecord[] = [];
  for (const record of entry.records) {
    if (shouldRetainWithoutInspection(entry.scope.kind, record, policy)) {
      retained.push(record);
      if (isOpenWebSessionSkip(entry.scope.kind, record, policy)) {
        summary.skippedForOpenWebSession = true;
      }
      continue;
    }
    summary.inspected += 1;
    summary.inspectedPids.push(record.pid);
    const outcome = await reapOwnedProcess(record, policy);
    appendReapOutcome(summary, record, outcome, retained);
  }
  return retained;
}

function shouldRetainWithoutInspection(
  scope: 'daemon' | 'session',
  record: OwnedProcessRecord,
  policy: ReapPolicy,
): boolean {
  return !isSelectedPurpose(record, policy) || isOpenWebSessionSkip(scope, record, policy);
}

function isSelectedPurpose(record: OwnedProcessRecord, policy: ReapPolicy): boolean {
  return policy.purposes === undefined || policy.purposes.has(record.purpose);
}

function isOpenWebSessionSkip(
  scope: 'daemon' | 'session',
  record: OwnedProcessRecord,
  policy: ReapPolicy,
): boolean {
  return scope === 'daemon' && record.purpose === 'managed-web-browser' && policy.openWebSession;
}

type ReapOutcome = 'terminated' | 'missing' | 'unconfirmed' | 'survived';

function appendReapOutcome(
  summary: MutableReapSummary,
  record: OwnedProcessRecord,
  outcome: ReapOutcome,
  retained: OwnedProcessRecord[],
): void {
  summary[outcome] += 1;
  summary[`${outcome}Pids`].push(record.pid);
  if (outcome === 'unconfirmed' || outcome === 'survived') retained.push(record);
}

/**
 * Stops one recorded process through the shared escalation. The record names the process by start
 * time and exact command, so a pid the host shows running anything else is proven gone and never
 * signaled, and one the host will not describe is kept rather than guessed at.
 */
async function reapOwnedProcess(
  record: OwnedProcessRecord,
  policy: Pick<ReapPolicy, 'termTimeoutMs' | 'killTimeoutMs'>,
): Promise<ReapOutcome> {
  if (record.pid === process.pid) return 'missing';
  const stop = await stopProcessAndConfirmExit(
    {
      pid: record.pid,
      identity: { startTime: record.startTime, matches: (command) => command === record.command },
    },
    { ...policy, gracefulSignal: gracefulSignalFor(record) },
  );
  return reapOutcomeOf(stop);
}

function reapOutcomeOf(stop: ConfirmedProcessStop): ReapOutcome {
  // A pid proven to name another process is forgotten as missing, whether or not it was signaled
  // first: nobody watched the recorded process leave.
  if (stop.status === 'stopped') return stop.signal && !stop.reassigned ? 'terminated' : 'missing';
  return stop.reason === 'identity-unverified' ? 'unconfirmed' : 'survived';
}

// simctl finalizes a recording only on SIGINT; SIGTERM leaves an unplayable file.
function gracefulSignalFor(record: OwnedProcessRecord): 'SIGINT' | 'SIGTERM' {
  return record.purpose === 'simctl-screen-recording' ? 'SIGINT' : 'SIGTERM';
}
