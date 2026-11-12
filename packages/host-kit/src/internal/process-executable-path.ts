import { readlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout, clearTimeout } from 'node:timers';
import { runCmd, withoutCommandExecutorOverride } from './exec.ts';
import { hostPlatform, uniquePositivePids } from './host-process.ts';

const DEFAULT_TIMEOUT_MS = 1_000;
const WINDOWS_TIMEOUT_FLOOR_MS = 2_000;
const PATH_BUFFER_BYTES = 4_096;
const WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

/** Observes actual executable paths. Missing entries are unknown, not proof of exit. */
export async function readProcessExecutablePaths(
  pids: Iterable<number>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ReadonlyMap<number, string>> {
  const selected = uniquePositivePids(pids).filter((pid) => pid <= 2_147_483_647);
  if (selected.length === 0) return new Map();
  const platform = hostPlatform();
  if (platform === 'linux') return await readLinuxPaths(selected, timeoutMs);
  if (platform !== 'darwin' && platform !== 'win32') return new Map();
  return await withoutCommandExecutorOverride(async () => {
    try {
      const windows = platform === 'win32';
      const result = await runCmd(
        windows ? WINDOWS_POWERSHELL : '/usr/bin/osascript',
        windows ? windowsArgs(selected) : darwinArgs(selected),
        {
          allowFailure: true,
          timeoutMs: windows ? Math.max(timeoutMs, WINDOWS_TIMEOUT_FLOOR_MS) : timeoutMs,
        },
      );
      return result.exitCode === 0 ? parsePaths(result.stdout, selected, windows) : new Map();
    } catch {
      return new Map();
    }
  });
}

async function readLinuxPaths(
  pids: readonly number[],
  timeoutMs: number,
): Promise<Map<number, string>> {
  const observations = Promise.all(
    pids.map(async (pid) => {
      try {
        const bytes = await readlink(`/proc/${pid}/exe`, { encoding: 'buffer' });
        if (bytes.length >= PATH_BUFFER_BYTES) return undefined;
        const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return validPath(value, false) && !value.endsWith(' (deleted)')
          ? ([pid, value] as const)
          : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  let cancelTimeout = () => {};
  try {
    const rows = await Promise.race([
      observations,
      new Promise<undefined>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        cancelTimeout = () => clearTimeout(timer);
      }),
    ]);
    return new Map(rows?.filter((row) => row !== undefined) ?? []);
  } finally {
    cancelTimeout();
  }
}

function darwinArgs(pids: readonly number[]): string[] {
  const script = `ObjC.import("Foundation"); ObjC.bindFunction("proc_pidpath", ["int", ["int", "void *", "uint32"]]); JSON.stringify(${JSON.stringify(pids)}.map(function(pid) { var b=$.NSMutableData.dataWithLength(${PATH_BUFFER_BYTES}); var n=$.proc_pidpath(pid,b.mutableBytes,${PATH_BUFFER_BYTES}); if(n<=0 || n>=${PATH_BUFFER_BYTES}) return {pid:pid}; var d=$.NSData.dataWithBytesLength(b.bytes,n); try { var s=$.NSString.alloc.initWithDataEncoding(d,$.NSUTF8StringEncoding); return {pid:pid,path:ObjC.unwrap(s)}; } catch (_) { return {pid:pid}; } }));`;
  return ['-l', 'JavaScript', '-e', script];
}

function windowsArgs(pids: readonly number[]): string[] {
  const filter = pids.map((pid) => `ProcessId=${pid}`).join(' OR ');
  const script = `$OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { @{pid=$_.ProcessId; path=$_.ExecutablePath} })`;
  return ['-NoProfile', '-NonInteractive', '-Command', script];
}

function parsePaths(
  output: string,
  pids: readonly number[],
  windows: boolean,
): Map<number, string> {
  const paths = new Map<number, string>();
  try {
    const rows: unknown = JSON.parse(output.replace(/^\uFEFF/, ''));
    if (!Array.isArray(rows)) return paths;
    const requested = new Set(pids);
    const seen = new Set<number>();
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const { pid, path: value } = row as { pid?: unknown; path?: unknown };
      if (typeof pid !== 'number' || !requested.has(pid)) continue;
      if (seen.has(pid)) {
        paths.delete(pid);
        continue;
      }
      seen.add(pid);
      if (typeof value === 'string' && validPath(value, windows)) paths.set(pid, value);
    }
  } catch {
    return new Map();
  }
  return paths;
}

function validPath(value: string, windows: boolean): boolean {
  return (
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') < PATH_BUFFER_BYTES &&
    !/[\0\uFFFD]/.test(value) &&
    (windows ? path.win32.isAbsolute(value) : path.posix.isAbsolute(value))
  );
}
