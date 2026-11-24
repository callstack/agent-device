import { createHash } from 'node:crypto';
import path from 'node:path';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import type { EnvMap, HostEnvironment } from '@agent-device/kernel/source-value';
import type { CloudSessionBinding } from '@agent-device/remote/remote-connection-state';
import { cloudConnectionDir, type ConnectionLocation } from './cloud-connection-record.ts';
import type { CloudAttachment } from './cloud-session-api.ts';

const CLOUD_LIMRUN_REASONS = {
  // The installed Limrun plugin cannot consume scoped hosted attachments.
  pluginRequired: { reason: 'cloud_limrun_plugin_required' },
  // The client could not confirm its attachment daemon stopped.
  daemonStopUnconfirmed: { reason: 'cloud_attachment_daemon_stop_unconfirmed' },
} as const satisfies ReasonTable<'cloud sessions'>;

export async function hasHostedLimrunPlugin(env: EnvMap): Promise<boolean> {
  const { primePluginConnections, pluginConnectionCapabilities } =
    await import('@agent-device/plugins/connection');
  await primePluginConnections(env);
  return pluginConnectionCapabilities('limrun', env)?.acceptsHostedAttachment === true;
}

export async function requireHostedLimrunPlugin(env: EnvMap): Promise<void> {
  if (await hasHostedLimrunPlugin(env)) return;
  throw new AppError('COMMAND_FAILED', 'A compatible Limrun plugin is required for this session.', {
    reason: CLOUD_LIMRUN_REASONS.pluginRequired.reason,
    hint: 'Update the Limrun plugin before using this session, or run agent-device disconnect.',
  });
}

export function cloudLimrunDaemonDir(
  location: ConnectionLocation,
  binding: CloudSessionBinding,
): string {
  const key = createHash('sha256').update(binding.generation).digest('hex');
  return path.join(cloudConnectionDir(location), 'daemon-' + key.slice(0, 20));
}

export function cloudLimrunEnv(
  attachment: Extract<CloudAttachment, { kind: 'limrun' }>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    LIMRUN_API_KEY: undefined,
    LIMRUN_KEEP_ALIVE: undefined,
    LIMRUN_IOS_MODEL: undefined,
    LIMRUN_REGION: undefined,
    LIM_IOS_INSTANCE_URL: undefined,
    LIM_IOS_INSTANCE_TOKEN: undefined,
    LIM_ANDROID_INSTANCE_URL: undefined,
    LIM_ANDROID_INSTANCE_TOKEN: undefined,
    LIM_ANDROID_INSTANCE_ADB_URL: undefined,
  };
  if (attachment.platform === 'ios') {
    env.LIM_IOS_INSTANCE_URL = attachment.apiUrl;
    env.LIM_IOS_INSTANCE_TOKEN = attachment.token;
  } else {
    env.LIM_ANDROID_INSTANCE_URL = attachment.apiUrl;
    env.LIM_ANDROID_INSTANCE_TOKEN = attachment.token;
    env.LIM_ANDROID_INSTANCE_ADB_URL = attachment.adbWebSocketUrl;
  }
  return env;
}

export async function stopHostedLimrunDaemon(
  location: ConnectionLocation,
  binding: CloudSessionBinding | undefined,
  host: HostEnvironment,
): Promise<void> {
  if (binding?.transport !== 'limrun') return;
  const paths = resolveDaemonPaths(cloudLimrunDaemonDir(location, binding), host);
  try {
    const { stopRecordedDaemon } = await import('@agent-device/daemon-client');
    const { readDaemonStopIdentity } =
      await import('@agent-device/daemon-contracts/daemon-registration');
    await stopRecordedDaemon(readDaemonStopIdentity(paths.infoPath), { paths, host });
  } catch {
    throw new AppError(
      'COMMAND_FAILED',
      'Could not confirm the hosted attachment daemon stopped.',
      {
        reason: CLOUD_LIMRUN_REASONS.daemonStopUnconfirmed.reason,
        hint: 'Run agent-device disconnect again to finish closing this session.',
      },
    );
  }
}
