import { resolveDaemonPaths } from '../../daemon/config.ts';
import type { RemoteConfigProfile } from '../../remote/remote-config-schema.ts';
import { AppError } from '../../kernel/errors.ts';
import type { CliFlags } from '../parser/cli-flags.ts';
import type { EnvMap } from '../../utils/env-map.ts';
import { readMetroProfileFields } from './profile-fields.ts';
import { persistAndResolveGeneratedProfile } from './generated-config.ts';
import { resolveRequestedLeaseBackend } from '../commands/connection-runtime.ts';

const DEFAULT_LIMRUN_TENANT = 'limrun';

export function resolveLimrunConnectProfile(options: {
  flags: CliFlags;
  stateDir: string;
  cwd: string;
  env?: EnvMap;
}): { flags: CliFlags; remoteConfigPath: string } {
  const env = options.env ?? process.env;
  const apiKey = env.LIMRUN_API_KEY?.trim() || env.LIM_API_KEY?.trim();
  if (!apiKey) {
    throw new AppError('INVALID_ARGS', 'connect limrun requires LIMRUN_API_KEY.', {
      hint: 'Set LIMRUN_API_KEY in the environment before running agent-device connect limrun.',
    });
  }

  const profile = buildLimrunRemoteProfile({ flags: options.flags });
  return persistAndResolveGeneratedProfile({
    stateDir: options.stateDir,
    provider: 'limrun',
    profile,
    cwd: options.cwd,
    env,
    flags: options.flags,
  });
}

function buildLimrunRemoteProfile(options: { flags: CliFlags }): RemoteConfigProfile {
  const flags = options.flags;
  const daemonPaths = resolveDaemonPaths(flags.stateDir);
  return {
    stateDir: daemonPaths.baseDir,
    daemonTransport: 'auto',
    tenant: flags.tenant ?? DEFAULT_LIMRUN_TENANT,
    runId: flags.runId ?? `cli-${Date.now().toString(36)}`,
    sessionIsolation: 'tenant',
    leaseBackend: resolveRequestedLeaseBackend(flags),
    leaseProvider: 'limrun',
    platform: flags.platform,
    target: flags.target ?? 'mobile',
    device: flags.device,
    udid: flags.udid,
    serial: flags.serial,
    iosSimulatorDeviceSet: flags.iosSimulatorDeviceSet,
    androidDeviceAllowlist: flags.androidDeviceAllowlist,
    session: flags.session,
    ...readMetroProfileFields(flags),
  };
}
