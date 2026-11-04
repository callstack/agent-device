import type {
  OwnedProcessRecord,
  OwnedProcessRecordScope,
} from '@agent-device/contracts/platform-runtime-host';
import {
  isProcessAlive,
  readProcessIdentityFacts,
  waitForProcessExit,
  type HostProcessIdentityFacts,
} from './host-process.ts';
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
  ownershipLost: number;
  ownershipLostPids: readonly number[];
  skippedForOpenWebSession: boolean;
}>;

export async function reapOwnedProcessRecordsAtStartup(
  store: OwnedProcessRecordStore,
  options: Readonly<{
    openWebSessionNames?: readonly string[];
    purposes?: readonly string[];
    termTimeoutMs?: number;
    killTimeoutMs?: number;
    withRecordingAdmission?: RecordingReapAdmission;
  }> = {},
): Promise<OwnedProcessReapSummary> {
  const summary = createReapSummary();
  const policy = createReapPolicy(options);
  for (const entry of store.read()) {
    if (!isDecodedRecord(entry)) continue;
    await reapDecodedEntry(store, entry, policy, summary);
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
  ownershipLost: number;
  ownershipLostPids: number[];
  skippedForOpenWebSession: boolean;
};

export type RecordingReapAdmission = (
  scope: OwnedProcessRecordScope,
  record: OwnedProcessRecord,
  reap: () => Promise<void>,
) => Promise<void>;

type ReapPolicy = Readonly<{
  openWebSession: boolean;
  purposes?: ReadonlySet<string>;
  termTimeoutMs: number;
  killTimeoutMs: number;
  withRecordingAdmission?: RecordingReapAdmission;
}>;

function createReapSummary(): MutableReapSummary {
  return {
    inspected: 0,
    inspectedPids: [],
    terminated: 0,
    terminatedPids: [],
    missing: 0,
    missingPids: [],
    ownershipLost: 0,
    ownershipLostPids: [],
    skippedForOpenWebSession: false,
  };
}

function createReapPolicy(options: {
  openWebSessionNames?: readonly string[];
  purposes?: readonly string[];
  termTimeoutMs?: number;
  killTimeoutMs?: number;
  withRecordingAdmission?: RecordingReapAdmission;
}): ReapPolicy {
  return {
    openWebSession: (options.openWebSessionNames ?? []).length > 0,
    purposes: options.purposes ? new Set(options.purposes) : undefined,
    termTimeoutMs: options.termTimeoutMs ?? DEFAULT_TERM_TIMEOUT_MS,
    killTimeoutMs: options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS,
    withRecordingAdmission: options.withRecordingAdmission,
  };
}

async function reapDecodedEntry(
  store: OwnedProcessRecordStore,
  entry: OwnedProcessRecordRead & { status: 'decoded' },
  policy: ReapPolicy,
  summary: MutableReapSummary,
): Promise<void> {
  for (const record of entry.records) {
    if (shouldRetainWithoutInspection(entry.scope.kind, record, policy)) {
      if (isOpenWebSessionSkip(entry.scope.kind, record, policy)) {
        summary.skippedForOpenWebSession = true;
      }
      continue;
    }
    const reap = async () => {
      if (!readMatchingRecord(store, entry.scope, record)) return;
      summary.inspected += 1;
      summary.inspectedPids.push(record.pid);
      const outcome = await reapOwnedProcess(record, policy);
      const retained: OwnedProcessRecord[] = [];
      appendReapOutcome(summary, record, outcome, retained);
      if (retained.length === 0) removeMatchingRecord(store, entry.scope, record);
    };
    if (record.purpose === 'simctl-screen-recording') {
      await policy.withRecordingAdmission?.(entry.scope, record, reap);
    } else {
      await reap();
    }
  }
}

function readMatchingRecord(
  store: OwnedProcessRecordStore,
  scope: OwnedProcessRecordScope,
  expected: OwnedProcessRecord,
): OwnedProcessRecordRead | undefined {
  return store
    .read()
    .find(
      (entry) =>
        entry.status === 'decoded' &&
        entry.scope.kind === scope.kind &&
        (scope.kind === 'daemon' ||
          (entry.scope.kind === 'session' && entry.scope.sessionId === scope.sessionId)) &&
        entry.records.some((record) => sameRecord(record, expected)),
    );
}

function removeMatchingRecord(
  store: OwnedProcessRecordStore,
  scope: OwnedProcessRecordScope,
  expected: OwnedProcessRecord,
): void {
  const current = readMatchingRecord(store, scope, expected);
  if (!current) return;
  const retained = current.records.filter((record) => !sameRecord(record, expected));
  if (retained.length === 0) store.clear(scope);
  else store.replace(scope, retained);
}

function sameRecord(left: OwnedProcessRecord, right: OwnedProcessRecord): boolean {
  return (
    left.pid === right.pid &&
    left.startTime === right.startTime &&
    left.command === right.command &&
    left.purpose === right.purpose
  );
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

function appendReapOutcome(
  summary: MutableReapSummary,
  record: OwnedProcessRecord,
  outcome: Awaited<ReturnType<typeof reapOwnedProcess>>,
  retained: OwnedProcessRecord[],
): void {
  if (outcome === 'terminated') {
    summary.terminated += 1;
    summary.terminatedPids.push(record.pid);
    return;
  }
  if (outcome === 'missing') {
    summary.missing += 1;
    summary.missingPids.push(record.pid);
    return;
  }
  summary.ownershipLost += 1;
  summary.ownershipLostPids.push(record.pid);
  retained.push(record);
}

async function reapOwnedProcess(
  record: OwnedProcessRecord,
  policy: Pick<ReapPolicy, 'termTimeoutMs' | 'killTimeoutMs'>,
): Promise<'terminated' | 'missing' | 'ownership-lost'> {
  const initial = await inspectOwnedProcess(record);
  if (initial !== undefined) return initial;
  signalBestEffort(record.pid, initialSignalFor(record));
  return await escalateOwnedProcess(record, policy);
}

async function inspectOwnedProcess(
  record: OwnedProcessRecord,
): Promise<'missing' | 'ownership-lost' | undefined> {
  if (record.pid === process.pid || !isProcessAlive(record.pid)) return 'missing';
  // One off-loop identity read answers the whole decision. Per-field probes
  // would spend a fresh process-tool startup on every record on hosts where
  // each read spawns a query tool rather than one cheap `ps`.
  const facts = await readProcessIdentityFacts(record.pid);
  if (facts.zombie) return 'missing';
  return matchesFacts(record, facts) ? undefined : 'ownership-lost';
}

function initialSignalFor(record: OwnedProcessRecord): NodeJS.Signals {
  return record.purpose === 'simctl-screen-recording' ? 'SIGINT' : 'SIGTERM';
}

async function escalateOwnedProcess(
  record: OwnedProcessRecord,
  policy: Pick<ReapPolicy, 'termTimeoutMs' | 'killTimeoutMs'>,
): Promise<'terminated' | 'ownership-lost'> {
  const termOutcome = await waitForOwnedProcessExit(record, policy.termTimeoutMs);
  if (termOutcome === 'exited') return 'terminated';
  if (termOutcome === 'ownership-lost') return 'ownership-lost';
  signalBestEffort(record.pid, 'SIGKILL');
  const killOutcome = await waitForOwnedProcessExit(record, policy.killTimeoutMs);
  return killOutcome === 'exited' ? 'terminated' : 'ownership-lost';
}

async function waitForOwnedProcessExit(
  record: OwnedProcessRecord,
  timeoutMs: number,
): Promise<'exited' | 'owned-alive' | 'ownership-lost'> {
  await waitForProcessExit(record.pid, timeoutMs);
  if (!isProcessAlive(record.pid)) return 'exited';
  const facts = await readProcessIdentityFacts(record.pid);
  if (facts.zombie) return 'exited';
  return matchesFacts(record, facts) ? 'owned-alive' : 'ownership-lost';
}

function matchesFacts(record: OwnedProcessRecord, facts: HostProcessIdentityFacts): boolean {
  return facts.startTime === record.startTime && facts.command === record.command;
}

function signalBestEffort(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // The process may have exited between the identity read and the signal.
  }
}
