import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { isApplePlatform, type PlatformSelector } from '@agent-device/kernel/device';
import { inspectMaestroFlow } from '@agent-device/maestro';
import { resolveRequestTrackingId } from '../../request/cancel.ts';
import { resolveReplayFormat } from '../../replay/format.ts';
import { readReplayScriptMetadata, type ReplayScriptMetadata } from '../../replay/script.ts';
import { discoverReplaySourcePaths } from '../replay-source-discovery.ts';

const MAX_REPLAY_TEST_RETRIES = 3;

export type ReplayTestDiscoveryEntry =
  | {
      kind: 'run';
      path: string;
      title?: string;
      metadata: ReplayScriptMetadata;
    }
  | {
      kind: 'skip';
      path: string;
      reason: 'skipped-by-filter';
      message: string;
    };

export type ReplayTestRunEntry = Extract<ReplayTestDiscoveryEntry, { kind: 'run' }>;

export function discoverReplayTestEntries(params: {
  inputs: string[];
  cwd?: string;
  platformFilter?: PlatformSelector;
  replayBackend?: string;
}): ReplayTestDiscoveryEntry[] {
  const { inputs, cwd, platformFilter, replayBackend } = params;
  const resolvedCwd = cwd ?? process.cwd();
  const filePaths = discoverReplaySourcePaths({
    inputs,
    cwd: resolvedCwd,
    replayBackend,
  });

  const entries: ReplayTestDiscoveryEntry[] = [];
  for (const filePath of filePaths) {
    const script = fs.readFileSync(filePath, 'utf8');
    const metadata = readReplayScriptMetadata(script);
    const title = readReplayTestTitle(script, filePath, replayBackend);
    if (!platformFilter) {
      entries.push({ kind: 'run', path: filePath, title, metadata });
      continue;
    }
    if (!metadata.platform) {
      if (resolveReplayFormat(filePath, replayBackend) === 'maestro') {
        entries.push({ kind: 'run', path: filePath, title, metadata });
      } else {
        entries.push({
          kind: 'skip',
          path: filePath,
          reason: 'skipped-by-filter',
          message: `missing platform metadata for --platform ${platformFilter}`,
        });
      }
      continue;
    }
    if (!matchesPlatformFilter(platformFilter, metadata.platform)) {
      continue;
    }
    entries.push({ kind: 'run', path: filePath, title, metadata });
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
  const slug = baseName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const testNumber = caseIndex + 1;
  return `${sessionName}:test:${suiteInvocationId}:${testNumber}${slug ? `-${slug}` : ''}:attempt-${attemptIndex + 1}`;
}

export function buildReplayTestInvocationId(requestId?: string): string {
  const raw = requestId?.trim() || `${process.pid}-${Date.now().toString(36)}`;
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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
  const shardPart = shardIndex === undefined ? '' : `:shard:${shardIndex + 1}`;
  return resolveRequestTrackingId(
    `${requestId ?? suiteInvocationId}${shardPart}:test:${caseIndex + 1}:${path.basename(filePath)}:attempt:${attemptIndex + 1}`,
    suiteInvocationId,
  );
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

function readReplayTestTitle(
  script: string,
  filePath: string,
  replayBackend: string | undefined,
): string | undefined {
  return resolveReplayFormat(filePath, replayBackend) === 'maestro'
    ? inspectMaestroFlow(script, filePath).name
    : undefined;
}

function matchesPlatformFilter(filter: PlatformSelector, candidate: PlatformSelector): boolean {
  if (filter === 'apple') {
    return isApplePlatform(candidate);
  }
  return candidate === filter;
}
