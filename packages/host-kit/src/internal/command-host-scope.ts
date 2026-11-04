import { AsyncLocalStorage } from 'node:async_hooks';
import { AppError } from '@agent-device/kernel/errors';
import type { EnvMap, HostEnvironment } from '@agent-device/kernel/source-value';

type CommandHostScope = Readonly<{
  host: HostEnvironment;
  requestEnv: EnvMap | undefined;
}>;

const commandHostScope = new AsyncLocalStorage<CommandHostScope>();

/**
 * Runs `fn` as the host that owns the commands it spawns. A command without its own `env` starts
 * from `host.env`, then takes `requestEnv` on top, so neither the process's environment nor a
 * concurrent request's values reach it. Outside a scope a command without `env` inherits the process's.
 */
export async function withCommandHost<T>(
  scope: CommandHostScope,
  fn: () => Promise<T>,
): Promise<T> {
  // A nested scope of the same host that names no request env keeps the enclosing request's.
  const enclosing = commandHostScope.getStore();
  const requestEnv =
    scope.requestEnv ?? (enclosing?.host === scope.host ? enclosing.requestEnv : undefined);
  return await commandHostScope.run({ host: scope.host, requestEnv }, fn);
}

/** Keeps an explicit command environment while preserving request toolchain selection. */
export async function withRestrictedCommandEnvironment<T>(
  host: HostEnvironment,
  fn: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const enclosing = commandHostScope.getStore();
  const env: NodeJS.ProcessEnv = { ...host.env };
  if (enclosing?.requestEnv && Object.hasOwn(enclosing.requestEnv, 'DEVELOPER_DIR')) {
    const developerDir = enclosing.requestEnv.DEVELOPER_DIR;
    if (developerDir) env.DEVELOPER_DIR = developerDir;
    else delete env.DEVELOPER_DIR;
  }
  return await commandHostScope.run(
    { host: { ...host, env }, requestEnv: undefined },
    async () => await fn(env),
  );
}

/**
 * The host of the enclosing {@link withCommandHost} scope, for code that has no host of its own.
 * Outside a scope there is no host to answer with, so it refuses rather than guess.
 */
export function commandHostEnvironment(): HostEnvironment {
  const scope = commandHostScope.getStore();
  if (!scope) {
    throw new AppError('COMMAND_FAILED', 'No host environment is bound to this command.', {
      reason: 'host_environment_unscoped',
    });
  }
  return scope.host;
}

/** Effective toolchain selection; an explicitly empty request value selects `xcode-select`. */
export function commandDeveloperDir(): string | undefined {
  const scope = commandHostScope.getStore();
  if (scope?.requestEnv && Object.hasOwn(scope.requestEnv, 'DEVELOPER_DIR')) {
    return scope.requestEnv.DEVELOPER_DIR || undefined;
  }
  return scope?.host.env.DEVELOPER_DIR || undefined;
}

export function resolveSpawnEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv | undefined {
  const scope = commandHostScope.getStore();
  if (!scope) return env;
  return { ...(env ?? scope.host.env), ...scope.requestEnv };
}

export function getCommandTraceEnv(): EnvMap | undefined {
  return commandHostScope.getStore()?.host.env;
}
