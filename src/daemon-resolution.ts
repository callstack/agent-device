import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expandUserHomePath, resolveUserPath } from '@agent-device/host-kit/file';
import { findProjectRoot, isSourceCheckoutProjectRoot } from '@agent-device/host-kit/version';
import { type EnvMap } from '@agent-device/kernel/source-value';

import type { DaemonServerMode, DaemonTransportPreference } from '@agent-device/kernel/contracts';
export type { DaemonServerMode, DaemonTransportPreference };

/**
 * Where a daemon lives and how to reach it, resolved from raw env/arg values. The client and the
 * daemon both read this subset — the client to find or launch a daemon, the daemon to bind one —
 * so it sits at the process root rather than under `src/daemon/`, where a client would have to
 * reach daemon internals to resolve an address. `src/daemon/config.ts` adds the request-scoping
 * rules that only the daemon applies on top of this.
 */

export type DaemonPaths = {
  baseDir: string;
  infoPath: string;
  lockPath: string;
  logPath: string;
  allocationsDir: string;
  sessionsDir: string;
};

type ResolveDaemonPathsOptions = {
  env?: EnvMap;
  projectRoot?: string;
};

export function resolveDaemonPaths(
  stateDir: string | undefined,
  options: ResolveDaemonPathsOptions = {},
): DaemonPaths {
  const baseDir = resolveStateDir(stateDir, options);
  return {
    baseDir,
    infoPath: path.join(baseDir, 'daemon.json'),
    lockPath: path.join(baseDir, 'daemon.lock'),
    logPath: path.join(baseDir, 'daemon.log'),
    allocationsDir: path.join(baseDir, 'allocations'),
    sessionsDir: path.join(baseDir, 'sessions'),
  };
}

function resolveStateDir(raw: string | undefined, options: ResolveDaemonPathsOptions): string {
  const value = (raw ?? '').trim();
  if (!value) {
    return resolveDefaultDaemonStateDir(options);
  }
  return resolveUserPath(value, { env: options.env });
}

function resolveDefaultDaemonStateDir(options: ResolveDaemonPathsOptions = {}): string {
  const globalStateDir = path.join(expandUserHomePath('~', { env: options.env }), '.agent-device');
  const projectRoot = options.projectRoot ?? findProjectRoot();
  if (!isSourceCheckoutProjectRoot(projectRoot)) {
    return globalStateDir;
  }
  return path.join(globalStateDir, 'dev', buildSourceCheckoutStateDirName(projectRoot));
}

function buildSourceCheckoutStateDirName(projectRoot: string): string {
  const resolvedRoot = resolveRealPath(projectRoot);
  const slug = path.basename(resolvedRoot).replaceAll(/[^a-zA-Z0-9._-]+/g, '-');
  const hash = crypto.createHash('sha1').update(resolvedRoot).digest('hex').slice(0, 12);
  return `${slug || 'agent-device'}-${hash}`;
}

function resolveRealPath(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

export function resolveDaemonServerMode(raw: string | undefined): DaemonServerMode {
  const normalized = (raw ?? '').trim().toLowerCase();
  if (normalized === 'http') return 'http';
  if (normalized === 'dual') return 'dual';
  return 'socket';
}

export function resolveDaemonTransportPreference(
  raw: string | undefined,
): DaemonTransportPreference {
  const normalized = (raw ?? '').trim().toLowerCase();
  if (normalized === 'auto') return 'auto';
  if (normalized === 'socket') return 'socket';
  if (normalized === 'http') return 'http';
  if (normalized === 'dual') return 'auto';
  return 'auto';
}
