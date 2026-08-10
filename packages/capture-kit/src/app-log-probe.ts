/** Runs an optional app-log probe without converting request cancellation into a false verdict. */
export async function bestEffortAppLogCheck(
  check: () => Promise<boolean>,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    return await check();
  } catch {
    if (signal?.aborted) throw signal.reason;
    return false;
  }
}

export function appLogCommandSucceeded(result: { exitCode: number | null }): boolean {
  return result.exitCode === 0;
}
