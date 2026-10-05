import path from 'node:path';
import { trimEdgeDashes } from '@agent-device/kernel/collections';
import { AppError } from '@agent-device/kernel/errors';
import { isApplePlatform, type PlatformSelector } from '@agent-device/kernel/device';
import type {
  ReplayTestDiscoverSources,
  ReplayTestManifest,
  ReplayTestPlatform,
} from './session-test-types.ts';

const MAX_REPLAY_TEST_RETRIES = 3;

export type ReplayTestDiscoveryEntry =
  | {
      kind: 'run';
      path: string;
      title?: string;
      manifest: ReplayTestManifest;
    }
  | {
      kind: 'skip';
      path: string;
      reason: 'skipped-by-filter';
      message: string;
    };

export type ReplayTestRunEntry = Extract<ReplayTestDiscoveryEntry, { kind: 'run' }>;

/**
 * Applies discovery policy to host-inspected sources (#1478 P3b).
 *
 * Inspection belongs to the host, which has the engines. This is the neutral half: which
 * sources a `--platform` filter runs, which it skips and with what message, and rejecting a
 * suite that matched nothing.
 */
export function discoverReplayTestEntries(params: {
  platformFilter?: PlatformSelector;
  discoverSources: ReplayTestDiscoverSources;
}): ReplayTestDiscoveryEntry[] {
  const { platformFilter, discoverSources } = params;
  const sources = discoverSources();

  const entries: ReplayTestDiscoveryEntry[] = [];
  // Both counts of why the filter matched nothing, accumulated together so the
  // no-match message never re-derives one from an entry shape it does not own.
  const filteredOut = { undeclared: 0, declaredOther: 0 };
  for (const source of sources) {
    const { path: filePath, manifest } = source;
    const run = { kind: 'run', path: filePath, title: manifest.title, manifest } as const;
    if (!platformFilter) {
      entries.push(run);
      continue;
    }
    const declared = manifest.device.platform;
    // A caller-bound source takes its platform from the invocation, so a filter never skips
    // it for lacking declared metadata; an unspecified one declared nothing and is skipped
    // with the message the suite result has always carried.
    if (declared.kind === 'caller-bound') {
      entries.push(run);
      continue;
    }
    if (declared.kind === 'unspecified') {
      filteredOut.undeclared += 1;
      entries.push({
        kind: 'skip',
        path: filePath,
        reason: 'skipped-by-filter',
        message: `missing platform metadata for --platform ${platformFilter}`,
      });
      continue;
    }
    if (!matchesPlatformFilter(platformFilter, declared.value)) {
      filteredOut.declaredOther += 1;
      continue;
    }
    entries.push(run);
  }

  const runnableCount = entries.filter((entry) => entry.kind === 'run').length;
  if (runnableCount === 0) {
    throw new AppError(
      'INVALID_ARGS',
      noReplayTestsMatchedMessage({ platformFilter, ...filteredOut }),
    );
  }

  return entries;
}

/** Why a `--platform` filter found nothing, as the two counts the filter itself produced. */
type NoReplayTestsMatchedReasons = {
  platformFilter: PlatformSelector | undefined;
  /** Sources with no platform declaration, which the filter skipped rather than dropped. */
  undeclared: number;
  /** Sources declaring some other platform, which the filter dropped entirely. */
  declaredOther: number;
};

/** The selectors a script cannot declare in its `context platform=` header. */
type NonDeclarablePlatform = Exclude<PlatformSelector, ReplayTestPlatform>;

// An exhaustive table, not a list: a platform that joins the gap between the filter
// vocabulary and `ReplayTestPlatform` fails here as a missing key, and one that leaves it
// fails as an excess key — so the predicate can never silently send the remedy toward a
// header the parser drops (`web` is excluded for #1900).
const NON_DECLARABLE_PLATFORMS: Record<NonDeclarablePlatform, true> = { web: true };

/**
 * Whether a filter value is one a script can name in its `context platform=` header: the
 * declarable vocabulary is `ReplayTestPlatform`, and the table above is enforced to be
 * exactly its gap from `PlatformSelector`, so the predicate cannot silently fall behind.
 */
function isDeclarableReplayPlatform(filter: PlatformSelector): filter is ReplayTestPlatform {
  return !Object.hasOwn(NON_DECLARABLE_PLATFORMS, filter);
}

/**
 * What "matched nothing" cost the caller (#3197). The two reasons read differently and the old
 * bare sentence hid the one the user needed: a header-less file is not a platform mismatch, and
 * the fix — a `context platform=` header, or dropping the filter — lived only in an internal skip
 * record. The suite's failure projection carries a code and a message and no hint, so both the
 * reason and the remedy belong in this one sentence.
 */
function noReplayTestsMatchedMessage(reasons: NoReplayTestsMatchedReasons): string {
  const { platformFilter, undeclared, declaredOther } = reasons;
  const suffix = platformFilter ? ` for --platform ${platformFilter}` : '';
  // Both counts come from the filter, so no filter (or no source at all) leaves the plain
  // sentence exactly as it read before: there is no skip or drop to explain.
  if (platformFilter === undefined || (undeclared === 0 && declaredOther === 0)) {
    return `No replay tests matched${suffix}.`;
  }
  const found = [
    ...(undeclared > 0 ? [`${undeclared} without a platform declaration`] : []),
    ...(declaredOther > 0 ? [`${declaredOther} declaring another platform`] : []),
  ].join(', ');
  return `No replay tests matched${suffix}: ${found}. ${noReplayTestsMatchedRemedy(platformFilter, undeclared)}`;
}

/**
 * The way out, stated only for a platform a source can actually name. `web` is excluded from
 * `ReplayTestPlatform`, so telling a caller to declare it would send them editing a header that
 * `readReplayScriptMetadata` then drops (#1900).
 */
function noReplayTestsMatchedRemedy(platformFilter: PlatformSelector, undeclared: number): string {
  if (!isDeclarableReplayPlatform(platformFilter)) {
    return `No script can declare ${platformFilter} as its platform; run this suite without --platform.`;
  }
  return undeclared > 0
    ? `Add "context platform=${platformFilter}" to the first line of a script that has none, or drop --platform when the device is already selected.`
    : `Run a source that declares ${platformFilter}, or drop --platform.`;
}

export function buildReplayTestSessionName(
  sessionName: string,
  suiteInvocationId: string,
  filePath: string,
  caseIndex: number,
  attemptIndex = 0,
): string {
  const baseName = path.basename(filePath, path.extname(filePath));
  const slug = trimEdgeDashes(baseName.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-'));
  const testNumber = caseIndex + 1;
  return `${sessionName}:test:${suiteInvocationId}:${testNumber}${slug ? `-${slug}` : ''}:attempt-${attemptIndex + 1}`;
}

export function buildReplayTestInvocationId(requestId?: string): string {
  const raw = requestId?.trim() || `${process.pid}-${Date.now().toString(36)}`;
  const normalized = trimEdgeDashes(raw.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-'));
  return normalized || 'suite';
}

export function buildReplayTestAttemptRequestId(params: {
  requestId?: string;
  suiteInvocationId: string;
  filePath: string;
  caseIndex: number;
  attemptIndex: number;
  shardIndex?: number;
}): string {
  const { requestId, suiteInvocationId, filePath, caseIndex, attemptIndex, shardIndex } = params;
  return [
    requestId ?? suiteInvocationId,
    ...(shardIndex === undefined ? [] : ['shard', shardIndex + 1]),
    'test',
    caseIndex + 1,
    path.basename(filePath),
    'attempt',
    attemptIndex + 1,
  ].join(':');
}

export function resolveReplayTestTimeout(
  cliTimeoutMs: unknown,
  metadataTimeoutMs: number | undefined,
): number | undefined {
  return typeof cliTimeoutMs === 'number' ? cliTimeoutMs : metadataTimeoutMs;
}

export function resolveReplayTestRetries(
  cliRetries: unknown,
  metadataRetries: number | undefined,
): number {
  const resolved = typeof cliRetries === 'number' ? cliRetries : metadataRetries;
  if (typeof resolved !== 'number') return 0;
  return Math.max(0, Math.min(MAX_REPLAY_TEST_RETRIES, resolved));
}

function matchesPlatformFilter(filter: PlatformSelector, candidate: ReplayTestPlatform): boolean {
  if (filter === 'apple') {
    return isApplePlatform(candidate);
  }
  return candidate === filter;
}
