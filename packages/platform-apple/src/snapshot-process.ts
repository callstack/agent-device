import { runAppleToolCommand } from './core/tool-provider.ts';

export async function readSnapshotTargetProcessStartTime(
  pid: number,
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<string | null> {
  const result = await runAppleToolCommand('ps', ['-p', String(pid), '-o', 'lstart='], {
    allowFailure: true,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}
