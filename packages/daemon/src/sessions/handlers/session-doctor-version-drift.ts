import path from 'node:path';
import { isExecutablePath, runCmd } from '@agent-device/host-kit/command';
import { readVersion } from '@agent-device/host-kit/version';
import { createTtlMemo } from '@agent-device/kernel/ttl-memo';
import type { EnvMap } from '@agent-device/kernel/source-value';
import type { DoctorCheck } from '@agent-device/contracts/observability';

const INSTALLED_BINARY = 'agent-device';
const VERSION_PROBE_TIMEOUT_MS = 5_000;
const CHECK_ID = 'install-drift';
const DRIFT_MEMO_TTL_MS = 10_000;

/** One agent-device binary reachable from PATH, with the version it reports (`null` when unreadable). */
export type InstallProbe = { path: string; version: string | null };

const driftMemo = createTtlMemo<string, DoctorCheck>({ ttlMs: DRIFT_MEMO_TTL_MS });

/**
 * Doctor's visibility into the mixed-entry trap: this daemon self-reports its build version, and
 * every `agent-device` binary on PATH is asked for its own. A PATH binary the daemon did not run
 * from still answers — that is the point. Versions equal to the daemon's are one consistent
 * install; a differing one is the stale global (or the fresher repo build) a mixed workflow
 * silently routes work to. Shell aliases (`$AD`) never reach a child env, so PATH is the whole
 * observable surface.
 *
 * Repeated doctor calls within the TTL reuse the verdict for the same PATH: the probe spawns one
 * child per install, and installs do not change between calls.
 */
export async function installedBuildsDriftCheck(env: EnvMap): Promise<DoctorCheck> {
  const pathValue = env['PATH'] ?? env['Path'] ?? '';
  const memoized = driftMemo.get(pathValue);
  if (memoized !== undefined) return memoized;
  const check = await probeInstalledBuildsDrift(env);
  driftMemo.set(pathValue, check);
  return check;
}

async function probeInstalledBuildsDrift(env: EnvMap): Promise<DoctorCheck> {
  const daemonVersion = readVersion();
  const binaries = await findInstalledBinaries(env);
  const probes = await Promise.all(binaries.map((binaryPath) => probeVersion(binaryPath, env)));
  return installDriftCheck(daemonVersion, probes);
}

/**
 * The agent-device binaries PATH reaches, in PATH order. This mirrors the exec owner's
 * PATH walk (bare-name lookup over the captured env) instead of importing one: the exec
 * module sits at its eager-closure and file-size gates, and doctor is this scan's only
 * consumer. Windows .cmd shims are not probed: a child cannot spawn them directly, so
 * discovery there answers bare executables only.
 */
async function findInstalledBinaries(env: EnvMap): Promise<string[]> {
  const pathValue = env['PATH'] ?? env['Path'];
  if (!pathValue) return [];
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const directory of pathValue.split(path.delimiter)) {
    const trimmedDirectory = directory.trim();
    if (!trimmedDirectory) continue;
    const hit = path.join(trimmedDirectory, INSTALLED_BINARY);
    if (seen.has(hit)) continue;
    if (await isExecutablePath(hit)) {
      seen.add(hit);
      hits.push(hit);
    }
  }
  return hits;
}

/** The drift verdict for probed installs; exported for tests beside the probe path. */
export function installDriftCheck(
  daemonVersion: string,
  probes: readonly InstallProbe[],
): DoctorCheck {
  const evidence = {
    daemonVersion,
    binaries: probes.map((probe) => ({ path: probe.path, version: probe.version })),
  };
  const drifted = probes.filter(
    (probe) => probe.version !== null && probe.version !== daemonVersion,
  );
  if (drifted.length > 0) {
    const versions = [...new Set(drifted.map((probe) => probe.version as string))].join(', ');
    return {
      id: CHECK_ID,
      status: 'warn',
      summary: `agent-device on PATH reports ${versions}; this daemon runs ${daemonVersion}.`,
      hint: 'Run one agent-device build per project. Keep daily work on the global CLI. Use the repo build only inside this checkout.',
      evidence,
    };
  }
  if (probes.length === 0) {
    return {
      id: CHECK_ID,
      status: 'pass',
      summary: 'No agent-device binary found on PATH.',
      evidence,
    };
  }
  if (probes.every((probe) => probe.version === null)) {
    return {
      id: CHECK_ID,
      status: 'info',
      summary: 'Could not read a version from the agent-device binaries on PATH.',
      evidence,
    };
  }
  return {
    id: CHECK_ID,
    status: 'pass',
    summary: 'All agent-device binaries on PATH match this daemon build.',
    evidence,
  };
}

async function probeVersion(binaryPath: string, env: EnvMap): Promise<InstallProbe> {
  try {
    const result = await runCmd(binaryPath, ['--version'], {
      env: { ...env },
      timeoutMs: VERSION_PROBE_TIMEOUT_MS,
      allowFailure: true,
    });
    const version = result.stdout.trim().split('\n')[0]?.trim();
    return { path: binaryPath, version: version ? version : null };
  } catch {
    return { path: binaryPath, version: null };
  }
}
