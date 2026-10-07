import crypto from 'node:crypto';
import type { EnvMap } from '@agent-device/kernel/source-value';

/** Read from the daemon's own environment only; a request never carries a GitHub credential. */
export const DAEMON_GITHUB_TOKEN_ENV = 'AGENT_DEVICE_GITHUB_TOKEN';
/** An optional `owner/repo,owner/repo` list of the repositories the daemon token may read. */
export const DAEMON_GITHUB_REPOSITORIES_ENV = 'AGENT_DEVICE_GITHUB_REPOSITORIES';

export function readDaemonGitHubToken(env: EnvMap): string | undefined {
  return env[DAEMON_GITHUB_TOKEN_ENV]?.trim() || undefined;
}

export function readDaemonGitHubRepositories(env: EnvMap): readonly string[] | undefined {
  const entries = env[DAEMON_GITHUB_REPOSITORIES_ENV]
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries?.length ? entries : undefined;
}

/**
 * A non-reversible digest of the daemon's GitHub token. The daemon publishes it so a client that
 * holds a token can refuse to reuse a daemon started without it, or with another one.
 */
export function daemonGitHubTokenFingerprint(env: EnvMap): string | undefined {
  const token = readDaemonGitHubToken(env);
  if (!token) return undefined;
  return `v1:${crypto.createHash('sha256').update(token).digest('hex').slice(0, 32)}`;
}
