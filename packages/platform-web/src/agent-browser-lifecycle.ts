import path from 'node:path';
import { uniqueStrings } from '@agent-device/kernel/collections';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { hostFileStatSync, readHostDirectorySync } from '@agent-device/host-kit/host-file';
import {
  hostEnvironment,
  type OwnedProcessRecordStore,
  reapOwnedProcessRecordsAtStartup,
} from '@agent-device/host-kit/process';

import type { AgentBrowserToolStatus } from './agent-browser-tool.ts';
import type { AgentBrowserProcessSummary } from './agent-browser-process-record.ts';
export {
  agentBrowserChromeLaunchMarker,
  appendAgentDeviceChromeArgs,
  inspectManagedAgentBrowserProcesses,
  matchAgentBrowserChromeProcess,
  recordManagedAgentBrowserProcesses,
  summarizeAgentBrowserProcesses,
  summarizeManagedAgentBrowserProcesses,
} from './agent-browser-process-record.ts';
export type { AgentBrowserProcessSummary } from './agent-browser-process-record.ts';

const WEB_BROWSER_REAP_TERM_TIMEOUT_MS = 1_500;
const WEB_BROWSER_REAP_KILL_TIMEOUT_MS = 1_000;
const PROVIDER_STARTUP_CLEANUP_DEBOUNCE_MS = 30_000;
export const DEFAULT_AGENT_BROWSER_IDLE_TIMEOUT_MS = 5 * 60_000;

export type AgentBrowserCleanupSkipReason = 'open-web-session' | 'recent-browser-activity';

export type AgentBrowserCleanupResult = AgentBrowserProcessSummary & {
  signalPids: number[];
  skipped?: {
    reason: AgentBrowserCleanupSkipReason;
    openWebSessionNames?: string[];
    idleTimeoutMs?: number;
    latestActivityMs?: number;
  };
};

export type AgentBrowserCleanupOptions = {
  openWebSessionNames?: readonly string[];
  ownedProcessRecords?: OwnedProcessRecordStore;
};

const providerStartupCleanupAttempts = new Map<string, number>();

export function resolveAgentBrowserIdleTimeoutMs(env: NodeJS.ProcessEnv): number {
  return (
    readPositiveInteger(env.AGENT_BROWSER_IDLE_TIMEOUT_MS) ??
    readPositiveInteger(env.AGENT_DEVICE_WEB_IDLE_TIMEOUT_MS) ??
    DEFAULT_AGENT_BROWSER_IDLE_TIMEOUT_MS
  );
}

export async function cleanupManagedAgentBrowserOrphans(
  status: AgentBrowserToolStatus,
  reason: 'daemon-startup' | 'provider-startup',
  options: AgentBrowserCleanupOptions = {},
): Promise<AgentBrowserCleanupResult> {
  const openWebSessionNames = uniqueStrings(
    (options.openWebSessionNames ?? []).filter((value) => value.length > 0),
  );
  if (openWebSessionNames.length > 0) {
    return skippedCleanupResult('open-web-session', { openWebSessionNames });
  }

  const idleTimeoutMs = resolveAgentBrowserIdleTimeoutMs(hostEnvironment());
  const latestActivityMs = readLatestManagedBrowserActivityMs(status);
  if (latestActivityMs !== undefined && Date.now() - latestActivityMs < idleTimeoutMs) {
    return skippedCleanupResult('recent-browser-activity', { idleTimeoutMs, latestActivityMs });
  }
  const store = options.ownedProcessRecords;
  if (!store) return emptyCleanupResult();
  const reaped = await reapOwnedProcessRecordsAtStartup(store, {
    openWebSessionNames,
    purposes: ['managed-web-browser'],
    termTimeoutMs: WEB_BROWSER_REAP_TERM_TIMEOUT_MS,
    killTimeoutMs: WEB_BROWSER_REAP_KILL_TIMEOUT_MS,
  });
  const signalPids = [...reaped.terminatedPids];
  if (reaped.inspected > 0) {
    emitDiagnostic({
      level: 'warn',
      phase: 'web_agent_browser_orphan_cleanup',
      data: {
        reason,
        count: reaped.inspected,
        pids: [...reaped.inspectedPids],
        signalPids,
        ownershipLostPids: [...reaped.ownershipLostPids],
        stateDir: status.stateDir,
        installDir: status.installDir,
      },
    });
  }
  return {
    count: reaped.inspected,
    pids: [...reaped.inspectedPids],
    processes: [],
    signalPids,
  };
}

export async function cleanupManagedAgentBrowserOrphansForProviderStartup(
  status: AgentBrowserToolStatus,
  options: AgentBrowserCleanupOptions = {},
): Promise<AgentBrowserCleanupResult | undefined> {
  const now = Date.now();
  const key = path.resolve(status.stateDir);
  const lastAttemptMs = providerStartupCleanupAttempts.get(key);
  if (lastAttemptMs !== undefined && now - lastAttemptMs < PROVIDER_STARTUP_CLEANUP_DEBOUNCE_MS) {
    return undefined;
  }
  providerStartupCleanupAttempts.set(key, now);
  return await cleanupManagedAgentBrowserOrphans(status, 'provider-startup', options);
}

function readPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function skippedCleanupResult(
  reason: AgentBrowserCleanupSkipReason,
  details: Omit<NonNullable<AgentBrowserCleanupResult['skipped']>, 'reason'>,
): AgentBrowserCleanupResult {
  return {
    count: 0,
    pids: [],
    processes: [],
    signalPids: [],
    skipped: { reason, ...details },
  };
}

function emptyCleanupResult(): AgentBrowserCleanupResult {
  return { count: 0, pids: [], processes: [], signalPids: [] };
}

function readLatestManagedBrowserActivityMs(status: AgentBrowserToolStatus): number | undefined {
  const mtimes = readDirectoryEntries(status.socketDir)
    .map((entryPath) => readPathMtimeMs(entryPath))
    .filter((mtimeMs): mtimeMs is number => mtimeMs !== undefined);
  return mtimes.length > 0 ? Math.max(...mtimes) : undefined;
}

function readDirectoryEntries(dirPath: string): string[] {
  try {
    return readHostDirectorySync(dirPath).map((entry) => path.join(dirPath, entry));
  } catch {
    return [];
  }
}

function readPathMtimeMs(filePath: string): number | undefined {
  try {
    return hostFileStatSync(filePath).mtimeMs;
  } catch {
    return undefined;
  }
}
