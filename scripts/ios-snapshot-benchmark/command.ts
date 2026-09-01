import { asRecord, readString } from './result-values.ts';
import { runCli, runCliAsync, type CliContext, type CliResult } from './cli-process.ts';
import type { Failure, FirstTreeStatus, RawSample, ScreenFixture } from './types.ts';

const APP_MOUNT_REASONS = new Set([
  'app_mount_race',
  'app_not_mounted',
  'active_ax_application_missing',
  'first_tree_empty',
  'first_tree_unreadable',
]);
const BRIDGE_REASONS = new Set([
  'bridge_unavailable',
  'bridge_request_failed',
  'metro_bridge_failed',
]);
const STALE_REASONS = new Set(['ref_frame_expired', 'stale_generation', 'stale_snapshot']);
const TIMEOUT_REASONS = new Set([
  'request_timeout',
  'command_timeout',
  'prepare_deadline_expired',
  'runner_main_thread_execution_timeout',
]);
const RUNNER_REASONS = new Set([
  'runner_health_failed',
  'runner_connect_failed_before_command_send',
  'runner_readiness_preflight_failed_before_command_send',
  'runner_reported_failure',
  'command_still_in_flight',
]);
const REASON_CATEGORIES: ReadonlyArray<[Set<string>, Failure['category']]> = [
  [STALE_REASONS, 'stale-generation'],
  [APP_MOUNT_REASONS, 'app-mount'],
  [BRIDGE_REASONS, 'bridge'],
  [TIMEOUT_REASONS, 'timeout'],
  [RUNNER_REASONS, 'runner'],
];
const TIMEOUT_CODES = new Set(['TIMEOUT', 'REQUEST_TIMEOUT', 'ETIMEDOUT']);

export type { CliContext, CliResult } from './cli-process.ts';

export function openFixture(
  context: CliContext,
  fixture: ScreenFixture,
  options: { relaunch?: boolean } = {},
): CliResult {
  const opened = runCli(context, [
    'open',
    fixture.app,
    ...(options.relaunch ? ['--relaunch'] : []),
    ...(fixture.launchUrl ? ['--launch-url', fixture.launchUrl] : []),
    '--foreground',
  ]);
  if (!fixture.launchUrl || !hasDeepLinkConfirmation(opened.payload)) return opened;
  const accepted = pressFixtureTarget(context, 'label="Open"');
  if (accepted.ok) return opened;
  return {
    ...opened,
    ok: false,
    stderr: [opened.stderr, accepted.stderr].filter(Boolean).join('\n'),
    payload: accepted.payload,
  };
}

export async function openFixtureAsync(
  context: CliContext,
  fixture: ScreenFixture,
  options: { relaunch?: boolean } = {},
): Promise<CliResult> {
  const opened = await runCliAsync(context, [
    'open',
    fixture.app,
    ...(options.relaunch ? ['--relaunch'] : []),
    ...(fixture.launchUrl ? ['--launch-url', fixture.launchUrl] : []),
    '--foreground',
  ]);
  if (!fixture.launchUrl || !hasDeepLinkConfirmation(opened.payload)) return opened;
  const accepted = await pressFixtureTargetAsync(context, 'label="Open"');
  if (accepted.ok) return opened;
  return {
    ...opened,
    ok: false,
    stderr: [opened.stderr, accepted.stderr].filter(Boolean).join('\n'),
    payload: accepted.payload,
  };
}

export function snapshotFixture(context: CliContext): CliResult {
  return runCli(context, [
    'batch',
    '--steps',
    JSON.stringify([{ command: 'snapshot', input: { interactiveOnly: true } }]),
  ]);
}

export async function snapshotFixtureAsync(context: CliContext): Promise<CliResult> {
  return await runCliAsync(context, [
    'batch',
    '--steps',
    JSON.stringify([{ command: 'snapshot', input: { interactiveOnly: true } }]),
  ]);
}

export function pressFixtureTarget(context: CliContext, selector: string): CliResult {
  return runCli(context, ['click', selector]);
}

export function scrollFixtureSetup(context: CliContext): CliResult {
  return runCli(context, ['scroll', 'bottom']);
}

export async function pressFixtureTargetAsync(
  context: CliContext,
  selector: string,
): Promise<CliResult> {
  return await runCliAsync(context, ['click', selector]);
}

export async function scrollFixtureSetupAsync(context: CliContext): Promise<CliResult> {
  return await runCliAsync(context, ['scroll', 'bottom']);
}

export async function closeSessionAsync(context: CliContext): Promise<void> {
  await runCliAsync(context, ['close']);
}

export function snapshotHasAnchor(payload: unknown, anchorText: string): boolean {
  return snapshotNodes(payload).some((record) => {
    return record.label === anchorText || record.value === anchorText;
  });
}

export function hasDeepLinkConfirmation(payload: unknown): boolean {
  return snapshotNodes(payload).some((record) => {
    const role = readString(record.role);
    const label = readString(record.label);
    return role === 'alert' && label?.startsWith('Open in ') === true;
  });
}

function snapshotNodes(payload: unknown): Record<string, unknown>[] {
  const snapshot = readSnapshotRecord(payload);
  if (!snapshot || !Array.isArray(snapshot.nodes)) return [];
  return snapshot.nodes.flatMap((node) => {
    const record = asRecord(node);
    return record ? [record] : [];
  });
}

export function sampleFromCli(
  result: CliResult,
  operation: RawSample['operation'],
  index: number,
  responseBytes = Buffer.byteLength(result.stdout),
): RawSample {
  const snapshot = readSnapshot(result.payload);
  const failure = result.ok ? undefined : classifyFailure(result.payload, result);
  const daemonDurationMs = readDaemonDuration(result.payload, operation);
  return {
    index: index + 1,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    operation,
    wallClockMs: result.wallClockMs,
    ...(daemonDurationMs === undefined ? {} : { daemonDurationMs }),
    responseBytes,
    ...snapshotFields(snapshot),
    targetGeneration: snapshot?.targetGeneration ?? null,
    firstTree: firstTreeStatusForSample(snapshot, failure),
    ok: result.ok,
    outlier: false,
    ...(failure ? { failure } : {}),
  };
}

function snapshotFields(snapshot: { nodeCount: number } | undefined): { nodeCount?: number } {
  return snapshot ? { nodeCount: snapshot.nodeCount } : {};
}

function firstTreeStatusForSample(
  snapshot: { nodeCount: number } | undefined,
  failure: Failure | undefined,
): FirstTreeStatus {
  if (snapshot) return snapshot.nodeCount === 0 ? 'empty' : 'readable';
  if (failure?.reason === 'first_tree_empty') return 'empty';
  return failure?.category === 'app-mount' ? 'unreadable' : 'not-observed';
}

export function classifyFailure(
  payload: unknown,
  result?: Pick<CliResult, 'stderr' | 'spawnErrorCode'>,
): Failure {
  const error = readError(payload);
  const code = readString(error?.code) ?? result?.spawnErrorCode;
  const details = asRecord(error?.details);
  const reason = readString(details?.reason);
  const category = failureCategory(code, reason);
  const message = readString(error?.message) ?? readString(result?.stderr);
  return {
    category,
    ...(code ? { code } : {}),
    ...(reason ? { reason } : {}),
    ...(message ? { message: message.slice(0, 240) } : {}),
  };
}

export function formatCliFailure(
  operation: string,
  failure: Failure,
  result: Pick<CliResult, 'stderr' | 'exitCode'>,
): string {
  return `${operation} failed [${failureLabel(failure)}]: ${failureMessage(failure, result)}`;
}

function failureLabel(failure: Failure): string {
  return failure.code ? `${failure.category}/${failure.code}` : failure.category;
}

function failureMessage(failure: Failure, result: Pick<CliResult, 'stderr' | 'exitCode'>): string {
  if (failure.message) return failure.message;
  if (result.stderr.trim()) return result.stderr.trim();
  return `exit ${result.exitCode}`;
}

export function firstTreeStatus(payload: unknown): FirstTreeStatus {
  const snapshot = readSnapshot(payload);
  if (snapshot) return snapshot.nodeCount === 0 ? 'empty' : 'readable';
  const error = readError(payload);
  const reason = readString(asRecord(error?.details)?.reason);
  return firstTreeStatusFromReason(reason);
}

function firstTreeStatusFromReason(reason: string | undefined): FirstTreeStatus {
  if (reason === 'first_tree_empty') return 'empty';
  return APP_MOUNT_REASONS.has(reason ?? '') ? 'unreadable' : 'not-observed';
}

function readDaemonDuration(
  payload: unknown,
  operation: RawSample['operation'],
): number | undefined {
  const record = asRecord(payload);
  const data = asRecord(record?.data);
  if (operation === 'snapshot') {
    const results = Array.isArray(data?.results) ? data.results : [];
    const first = asRecord(results[0]);
    return readFiniteNumber(first?.durationMs);
  }
  return readFiniteNumber(asRecord(data?.startup)?.durationMs);
}

function readSnapshot(
  payload: unknown,
): { nodeCount: number; targetGeneration: number | null } | undefined {
  const snapshot = readSnapshotRecord(payload);
  if (!snapshot) return undefined;
  const nodeCount = readSnapshotNodeCount(snapshot);
  if (nodeCount === undefined) return undefined;
  const generation = readFiniteNumber(snapshot.refsGeneration ?? snapshot.targetGeneration);
  return { nodeCount, targetGeneration: generation ?? null };
}

function readSnapshotRecord(payload: unknown): Record<string, unknown> | undefined {
  const record = asRecord(payload);
  const data = asRecord(record?.data) ?? record;
  const batchResults = Array.isArray(data?.results) ? data.results : [];
  const firstResult = asRecord(batchResults[0]);
  const stepData = asRecord(firstResult?.data) ?? data;
  return asRecord(stepData?.snapshot) ?? stepData;
}

function readSnapshotNodeCount(snapshot: Record<string, unknown>): number | undefined {
  const nodes = snapshot.nodes;
  return Array.isArray(nodes) ? nodes.length : readFiniteNumber(snapshot.nodeCount);
}

function failureCategory(
  code: string | undefined,
  reason: string | undefined,
): Failure['category'] {
  const category = REASON_CATEGORIES.find(
    ([reasons]) => reason !== undefined && reasons.has(reason),
  );
  return category?.[1] ?? (code && TIMEOUT_CODES.has(code) ? 'timeout' : 'other');
}

function readError(
  payload: unknown,
): { code?: unknown; message?: string; details?: unknown } | undefined {
  const record = asRecord(payload);
  const direct = asRecord(record?.error);
  if (direct) {
    return { code: direct.code, message: readString(direct.message), details: direct.details };
  }
  const initial = asRecord(asRecord(record?.data)?.initialSnapshotError);
  if (initial) {
    return { code: initial.code, message: readString(initial.message), details: initial.details };
  }
  return undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
