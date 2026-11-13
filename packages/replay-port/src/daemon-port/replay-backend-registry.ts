import type { ReplayBackendId } from '@agent-device/ad-script';
import type { ReplayBackend } from '@agent-device/contracts/replay-backend';
import type { ReplayBackendResolver } from '@agent-device/plugins/replay-backend';
import type { AppError } from '@agent-device/kernel/errors';

const backendResolverKey = Symbol('replay-backend-resolver');
async function binding() {
  const { runtimeSlot } = await import('@agent-device/host-kit/runtime-slots');
  return runtimeSlot(backendResolverKey, () => ({
    resolve: undefined as ReplayBackendResolver | undefined,
  }));
}

/** Binds the fixed plugin set of the current daemon runtime. Its registry owns disposal. */
export async function bindReplayBackendResolver(resolve: ReplayBackendResolver): Promise<void> {
  (await binding()).resolve = resolve;
}

/** Resolves against the current daemon's plugins, without consulting another host's store. */
export async function getReplayBackend(id: ReplayBackendId): Promise<ReplayBackend> {
  const resolve = (await binding()).resolve;
  const { AppError } = await import('@agent-device/kernel/errors');
  if (!resolve) throw await missingReplayBackend(id);
  const { createReplayBackendHost } = await import('./replay-backend-host.ts');
  try {
    return await resolve(id, createReplayBackendHost(), await backendPackage(id));
  } catch (error) {
    if (error instanceof AppError && error.details?.reason === 'plugin-not-installed')
      throw await missingReplayBackend(id);
    throw error;
  }
}

/** Loads client-side source collection or export in a scope that always disposes its plugin. */
export async function withReplayBackend<T>(
  id: ReplayBackendId,
  env: NodeJS.ProcessEnv,
  run: (backend: ReplayBackend) => Promise<T> | T,
): Promise<T> {
  if ((await binding()).resolve) return await run(await getReplayBackend(id));
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

async function missingReplayBackend(id: ReplayBackendId): Promise<AppError> {
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
      hint: 'Install on the client for source collection/export and on the daemon host for execution. Restart the daemon after changing plugins; retry the original command with all its arguments.',
    },
  );
}

async function backendPackage(id: ReplayBackendId): Promise<string> {
  return (await import('./replay-backend-declarations.ts')).getReplayBackendDeclaration(id).package;
}
