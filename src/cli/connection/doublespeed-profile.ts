import { resolveDaemonPaths } from '../../daemon/config.ts';
import type { RemoteConfigProfile } from '../../remote/remote-config-schema.ts';
import { AppError } from '@agent-device/kernel/errors';
import type { CliFlags } from '@agent-device/contracts/command';
import type { EnvMap } from '../../utils/env-map.ts';
import { readMetroProfileFields } from './profile-fields.ts';
import { persistAndResolveGeneratedProfile } from './generated-config.ts';
import { resolveRequestedLeaseBackend } from '../commands/connection-runtime.ts';

const DEFAULT_DOUBLESPEED_TENANT = 'doublespeed';
const DOUBLESPEED_LEASE_BACKEND = 'ios-instance';

export function resolveDoublespeedConnectProfile(options: {
  flags: CliFlags;
  stateDir: string;
  cwd: string;
  env?: EnvMap;
}): { flags: CliFlags; remoteConfigPath: string } {
  const env = options.env ?? process.env;
  const apiKey = env.DOUBLESPEED_API_KEY?.trim();
  if (!apiKey) {
    throw new AppError('INVALID_ARGS', 'connect doublespeed requires DOUBLESPEED_API_KEY.', {
      hint: 'Set DOUBLESPEED_API_KEY in the environment before running agent-device connect doublespeed.',
    });
  }

  const profile = buildDoublespeedRemoteProfile({ flags: options.flags });
  return persistAndResolveGeneratedProfile({
    stateDir: options.stateDir,
    provider: 'doublespeed',
    profile,
    cwd: options.cwd,
    env,
    flags: options.flags,
  });
}

function buildDoublespeedRemoteProfile(options: { flags: CliFlags }): RemoteConfigProfile {
  const flags = options.flags;
  validateDoublespeedConnectFlags(flags);
  const daemonPaths = resolveDaemonPaths(flags.stateDir);
  return {
    stateDir: daemonPaths.baseDir,
    daemonTransport: 'auto',
    tenant: flags.tenant ?? DEFAULT_DOUBLESPEED_TENANT,
    runId: flags.runId ?? `cli-${Date.now().toString(36)}`,
    sessionIsolation: 'tenant',
    leaseBackend: DOUBLESPEED_LEASE_BACKEND,
    leaseProvider: 'doublespeed',
    platform: 'ios',
    target: 'mobile',
    session: flags.session,
    ...readMetroProfileFields(flags),
  };
}

function validateDoublespeedConnectFlags(flags: CliFlags): void {
  if (flags.platform !== undefined && flags.platform !== 'ios') {
    throw new AppError('INVALID_ARGS', 'connect doublespeed supports --platform ios only.');
  }
  if (flags.device !== undefined) {
    throw new AppError(
      'INVALID_ARGS',
      'connect doublespeed does not accept --device; set DOUBLESPEED_DEVICE to pick the simulator model.',
    );
  }
  const leaseBackend = resolveRequestedLeaseBackend({ ...flags, platform: 'ios' });
  if (leaseBackend !== DOUBLESPEED_LEASE_BACKEND) {
    throw new AppError(
      'INVALID_ARGS',
      `connect doublespeed requires --lease-backend ${DOUBLESPEED_LEASE_BACKEND}.`,
    );
  }
}
