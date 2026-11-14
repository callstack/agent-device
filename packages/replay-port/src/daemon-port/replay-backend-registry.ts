import type {
  ReplayExecution,
  ReplayExecutionResolver,
} from '@agent-device/contracts/replay-execution';
import type { ReplayBackendId, ReplayFormat } from '@agent-device/ad-script';
import type { ReplayBackend, ReplayBackendResolver } from '@agent-device/contracts/replay-backend';
import type { AppError } from '@agent-device/kernel/errors';

const backendResolverKey = Symbol('replay-backend-resolver');
async function binding() {
  const { runtimeSlot } = await import('@agent-device/host-kit/runtime-slots');
  return runtimeSlot(backendResolverKey, () => ({
    resolve: undefined as ReplayBackendResolver | undefined,
    execution: undefined as ReplayExecutionResolver | undefined,
  }));
}

/** Binds the fixed plugin set of the current daemon runtime. Its registry owns disposal. */
export async function bindReplayBackendResolver(
  resolve: ReplayBackendResolver,
  execution?: ReplayExecutionResolver,
): Promise<void> {
  Object.assign(await binding(), { resolve, execution });
}

/** Resolves native replay and suite execution from this runtime's fixed plugin set. */
export async function getReplayExecution(): Promise<ReplayExecution> {
  const state = await binding();
  if (!state.execution) throw await missingReplayBackend('ad');
  try {
    return await state.execution(await backendPackage('ad'));
  } catch (error) {
    throw await recoverReplayPluginError('ad', error);
  }
}

async function recoverReplayPluginError(id: ReplayFormat, error: unknown): Promise<unknown> {
  const { AppError } = await import('@agent-device/kernel/errors');
  if (!(error instanceof AppError) || error.details?.reason !== 'plugin-not-installed')
    return error;
  return await missingReplayBackend(id);
}

/** Resolves against the current daemon's plugins, without consulting another host's store. */
export async function getReplayBackend(id: ReplayBackendId): Promise<ReplayBackend> {
  const { resolve } = await binding();
  if (!resolve) throw await missingReplayBackend(id);
  return await resolveBackend(id, resolve);
}

async function resolveBackend(
  id: ReplayBackendId,
  resolve: ReplayBackendResolver,
): Promise<ReplayBackend> {
  const { createReplayBackendHost } = await import('./replay-backend-host.ts');
  try {
    return await resolve(id, createReplayBackendHost(), await backendPackage(id));
  } catch (error) {
    throw await recoverReplayPluginError(id, error);
  }
}

/** Uses the embedded registry, or owns a client-side store scope until the task settles. */
export async function withReplayBackend<T>(
  id: ReplayBackendId,
  env: NodeJS.ProcessEnv,
  run: (backend: ReplayBackend) => Promise<T> | T,
  resolve?: ReplayBackendResolver,
): Promise<T> {
  if (resolve) return await run(await resolveBackend(id, resolve));
  const scope = await openReplayBackend(id, env);
  try {
    return await run(scope.backend);
  } finally {
    await scope.close();
  }
}

/** A client/tooling scope owns its plugin registry until close. It never starts providers. */
export async function openReplayBackend(id: ReplayBackendId, env: NodeJS.ProcessEnv) {
  const { AppError } = await import('@agent-device/kernel/errors');
  const [{ storePluginCandidates }, { resolveProviderPlugins, startProviderRegistry }] =
    await Promise.all([
      import('@agent-device/plugins/store'),
      import('@agent-device/plugins/registry'),
    ]);
  const registry = await startProviderRegistry(
    await resolveProviderPlugins(await storePluginCandidates(env)),
    env,
    {
      adaptWebDriver: async () => {
        throw new AppError('INVALID_ARGS', 'Client replay scope cannot start a provider');
      },
    },
    'replay-backends',
  );
  try {
    const { createReplayBackendHost } = await import('./replay-backend-host.ts');
    const backend = await registry.resolveReplayBackend(
      id,
      createReplayBackendHost(),
      await backendPackage(id),
    );
    return { backend, close: registry.close };
  } catch (error) {
    await registry.close();
    if (error instanceof AppError && error.details?.reason === 'plugin-not-installed')
      throw await missingReplayBackend(id);
    throw error;
  }
}

async function missingReplayBackend(id: ReplayFormat): Promise<AppError> {
  const { AppError } = await import('@agent-device/kernel/errors');
  const packageName = await backendPackage(id);
  const installCommand = `agent-device plugins add ${packageName}`;
  return new AppError(
    'INVALID_ARGS',
    `Replay backend ${id} requires ${packageName}. Run ${installCommand}, then retry the original command with all its arguments.`,
    {
      reason: 'plugin-not-installed',
      backend: id,
      package: packageName,
      installCommand,
      hint: `${(await import('@agent-device/ad-script')).getReplayPluginInstallation(id).installationHint} Restart the daemon after changing plugins; retry the original command with all its arguments.`,
    },
  );
}

async function backendPackage(id: ReplayFormat): Promise<string> {
  return (await import('@agent-device/ad-script')).getReplayPluginInstallation(id).package;
}
