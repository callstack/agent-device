import type { DoctorCheck, DoctorKind } from './session-doctor-types.ts';
import { runCmd } from '../../utils/exec.ts';

const METRO_PROBE_TIMEOUT_MS = 1500;
const METRO_PROCESS_LOOKUP_TIMEOUT_MS = 1500;

export type MetroProcessInfo = {
  pid: number;
  cwd?: string;
};

type MetroProbeOptions = {
  resolveProcessInfo?: (host: string, port: number) => Promise<MetroProcessInfo | undefined>;
};

export async function probeMetro(
  host: string,
  port: number,
  kind: DoctorKind,
  options: MetroProbeOptions = {},
): Promise<DoctorCheck> {
  const url = `http://${host}:${port}/status`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(METRO_PROBE_TIMEOUT_MS) });
    const text = await response.text();
    const running = response.ok && text.toLowerCase().includes('packager-status:running');
    const processInfo = running
      ? await resolveMetroProcessInfoSafely(host, port, options)
      : undefined;
    return {
      id: 'metro',
      status: running ? 'pass' : 'warn',
      summary: running
        ? metroRunningSummary(url, processInfo)
        : `Metro responded at ${url}, but did not report packager-status:running.`,
      hint: running
        ? undefined
        : 'Verify this is the Metro instance for the target app, or restart Metro.',
      evidence: {
        url,
        statusCode: response.status,
        body: text.slice(0, 120),
        kind,
        ...(processInfo ? { process: processInfo } : {}),
      },
    };
  } catch (error) {
    return {
      id: 'metro',
      status: kind === 'auto' ? 'warn' : 'fail',
      summary: `Metro is not reachable at ${url}.`,
      hint: 'Start Metro for this project. For non-default endpoints, launch with open --metro-host/--metro-port, or run metro prepare with --public-base-url/--proxy-base-url before retrying doctor.',
      command: `curl -fsS ${url}`,
      evidence: { url, error: error instanceof Error ? error.message : String(error), kind },
    };
  }
}

async function resolveMetroProcessInfoSafely(
  host: string,
  port: number,
  options: MetroProbeOptions,
): Promise<MetroProcessInfo | undefined> {
  try {
    return await (options.resolveProcessInfo ?? resolveMetroProcessInfo)(host, port);
  } catch {
    return undefined;
  }
}

function metroRunningSummary(url: string, processInfo: MetroProcessInfo | undefined): string {
  if (processInfo?.cwd) {
    return `Metro is reachable at ${url} (cwd: ${processInfo.cwd}).`;
  }
  return `Metro is reachable at ${url}.`;
}

async function resolveMetroProcessInfo(
  host: string,
  port: number,
): Promise<MetroProcessInfo | undefined> {
  if (!isLocalHost(host)) return undefined;
  const pid = await findListeningProcessId(port);
  if (pid === undefined) return undefined;
  return { pid, cwd: await readProcessCwd(pid) };
}

function isLocalHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0.0.0.0';
}

async function findListeningProcessId(port: number): Promise<number | undefined> {
  const result = await runCmd('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], {
    allowFailure: true,
    timeoutMs: METRO_PROCESS_LOOKUP_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) return undefined;
  return result.stdout
    .split('\n')
    .map((line) => (line.startsWith('p') ? Number.parseInt(line.slice(1), 10) : NaN))
    .find((pid) => Number.isInteger(pid) && pid > 0);
}

async function readProcessCwd(pid: number): Promise<string | undefined> {
  const result = await runCmd('lsof', ['-nP', '-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
    allowFailure: true,
    timeoutMs: METRO_PROCESS_LOOKUP_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) return undefined;
  return result.stdout
    .split('\n')
    .find((line) => line.startsWith('n') && line.length > 1)
    ?.slice(1);
}
