import type { DoctorCheck, DoctorKind } from './session-doctor-types.ts';

const METRO_PROBE_TIMEOUT_MS = 1500;

export async function probeMetro(
  host: string,
  port: number,
  kind: DoctorKind,
): Promise<DoctorCheck> {
  const url = `http://${host}:${port}/status`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(METRO_PROBE_TIMEOUT_MS) });
    const text = await response.text();
    const running = response.ok && text.toLowerCase().includes('packager-status:running');
    return {
      id: 'metro',
      status: running ? 'pass' : 'warn',
      summary: running
        ? `Metro is reachable at ${url}.`
        : `Metro responded at ${url}, but did not report packager-status:running.`,
      hint: running
        ? undefined
        : 'Verify this is the Metro instance for the target app, or restart Metro.',
      evidence: { url, statusCode: response.status, body: text.slice(0, 120), kind },
    };
  } catch (error) {
    return {
      id: 'metro',
      status: kind === 'auto' ? 'warn' : 'fail',
      summary: `Metro is not reachable at ${url}.`,
      hint: 'Start Metro, pass the correct --metro-host/--metro-port, or use a remote Metro profile.',
      command: `curl -fsS ${url}`,
      evidence: { url, error: error instanceof Error ? error.message : String(error), kind },
    };
  }
}
