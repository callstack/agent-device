import { resolveDaemonPaths } from '../../daemon/config.ts';
import type { RemoteConfigProfile } from '../../remote/remote-config-schema.ts';
import { AppError } from '../../kernel/errors.ts';
import type { CliFlags } from '../../contracts/cli-flags.ts';
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
  const apiKey = env.LIMRUN_API_KEY?.trim();
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
  const leaseBackend = validateLimrunConnectFlags(flags);
  const daemonPaths = resolveDaemonPaths(flags.stateDir);
  return {
    stateDir: daemonPaths.baseDir,
    daemonTransport: 'auto',
    tenant: flags.tenant ?? DEFAULT_LIMRUN_TENANT,
    runId: flags.runId ?? `cli-${Date.now().toString(36)}`,
    sessionIsolation: 'tenant',
    leaseBackend,
    leaseProvider: 'limrun',
    platform: flags.platform,
    target: 'mobile',
    session: flags.session,
    ...readMetroProfileFields(flags),
  };
}

function validateLimrunConnectFlags(flags: CliFlags): 'android-instance' | 'ios-instance' {
  if (flags.platform !== 'android' && flags.platform !== 'ios') {
    throw new AppError('INVALID_ARGS', 'connect limrun requires --platform ios or android.');
  }
  if (flags.device !== undefined) {
    throw new AppError(
      'INVALID_ARGS',
      'connect limrun does not accept --device; Limrun selects a remote simulator or emulator.',
    );
  }
  const leaseBackend = resolveRequestedLeaseBackend(flags);
  const expectedLeaseBackend = flags.platform === 'ios' ? 'ios-instance' : 'android-instance';
  if (leaseBackend !== expectedLeaseBackend) {
    throw new AppError(
      'INVALID_ARGS',
      `connect limrun --platform ${flags.platform} requires --lease-backend ${expectedLeaseBackend}.`,
    );
  }
  return expectedLeaseBackend;
}
