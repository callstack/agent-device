import { performance } from 'node:perf_hooks';
import { runCmdSync } from '@agent-device/host-kit/command';
import { resolveCliArgv, REPO_ROOT } from './config.ts';
import type { CliResult } from './types.ts';

const MAX_BUFFER = 64 * 1024 * 1024;
const CLI_ARGV = resolveCliArgv();

function tryParseJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Some commands print a trailing line after JSON; try the last JSON-looking block.
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function jsonOk(json: unknown): boolean {
  return !(json !== null && typeof json === 'object' && (json as { ok?: unknown }).ok === false);
}

// Invoke the built CLI once. `args` includes the command + positionals + dash-flags;
// `baseFlags` carries the isolation + device flags shared by every call.
export function invokeCli(
  args: string[],
  baseFlags: string[],
  options: { timeoutMs?: number; env?: Readonly<Record<string, string>> } = {},
): CliResult {
  const full = [...CLI_ARGV, ...args, ...baseFlags, '--json'];
  const t0 = performance.now();
  let stdout = '';
  let stderr = '';
  let exitCode = -1;
  try {
    // allowFailure so non-zero exits are recorded as samples instead of thrown; maxBuffer
    // raised because snapshot payloads exceed Node's ~1MB default.
    const r = runCmdSync(process.execPath, full, {
      cwd: REPO_ROOT,
      maxBuffer: MAX_BUFFER,
      allowFailure: true,
      timeoutMs: options.timeoutMs,
      env: options.env ? { ...process.env, ...options.env } : undefined,
    });
    stdout = r.stdout;
    stderr = r.stderr;
    exitCode = r.exitCode;
  } catch (error) {
    // Spawn-level failures (missing executable, timeout) — record as a failed sample.
    stderr = error instanceof Error ? error.message : String(error);
  }
  const wallClockMs = performance.now() - t0;
  const json = tryParseJson(stdout);
  return { exitCode, wallClockMs, stdout, stderr, json, ok: exitCode === 0 && jsonOk(json) };
}
