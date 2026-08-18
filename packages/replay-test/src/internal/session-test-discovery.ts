import path from 'node:path';
import { trimEdgeDashes } from './session-test-artifacts.ts';
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
      entries.push({
        kind: 'skip',
        path: filePath,
        reason: 'skipped-by-filter',
        message: `missing platform metadata for --platform ${platformFilter}`,
      });
      continue;
    }
    if (!matchesPlatformFilter(platformFilter, declared.value)) {
      continue;
    }
    entries.push(run);
  }

  const runnableCount = entries.filter((entry) => entry.kind === 'run').length;
  if (runnableCount === 0) {
    const suffix = platformFilter ? ` for --platform ${platformFilter}` : '';
    throw new AppError('INVALID_ARGS', `No replay tests matched${suffix}.`);
  }

  return entries;
}

export function buildReplayTestSessionName(
  sessionName: string,
  suiteInvocationId: string,
  filePath: string,
  caseIndex: number,
  attemptIndex = 0,
): string {
  const baseName = path.basename(filePath, path.extname(filePath));
  const slug = trimEdgeDashes(baseName.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  const testNumber = caseIndex + 1;
  return `${sessionName}:test:${suiteInvocationId}:${testNumber}${slug ? `-${slug}` : ''}:attempt-${attemptIndex + 1}`;
}

export function buildReplayTestInvocationId(requestId?: string): string {
  const raw = requestId?.trim() || `${process.pid}-${Date.now().toString(36)}`;
  const normalized = trimEdgeDashes(raw.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
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
