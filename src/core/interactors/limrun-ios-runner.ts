import { limrunRunnerError, withLimrunRunnerErrors } from './limrun-ios-runner-errors.ts';
import { awaitWithSignal } from '@agent-device/kernel/await-with-signal';
import { Deadline, type DeadlineClock, retryWithPolicy } from '@agent-device/host-kit/retry';
import { createLimrunAppleToolProvider } from './limrun-ios-tools.ts';
import type { AppleApplicationTools } from '@agent-device/contracts/application-lifecycle-runtime';
import { withMethodScope } from '@agent-device/kernel/scoped-provider';
import { createLimrunAppleApplicationTools } from './limrun-ios-application-tools.ts';
import { randomInt } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LimrunRuntimeDependencies } from '@agent-device/provider-limrun';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { AppError } from '@agent-device/kernel/errors';
import { readVersion } from '@agent-device/host-kit/version';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import {
  prepareLimrunRunnerProducts,
  uploadLimrunRunnerProducts,
  writeLimrunRunnerConfiguration,
} from './limrun-ios-runner-products.ts';

type LimrunIosRunner = Awaited<ReturnType<LimrunRuntimeDependencies['ios']['createRunner']>>;
type Session = Parameters<LimrunRuntimeDependencies['ios']['createRunner']>[0];

/** Owns the lease’s XCTest runs; closing an attached lease never terminates its simulator. */
export async function createLimrunIosRunner(
  session: Session,
  host: HostEnvironment,
  appleApplications: AppleApplicationTools,
): Promise<LimrunIosRunner> {
  const {
    createAppleRunnerRuntime,
    createLaunchedAppleRunnerProvider,
    RUNNER_STARTUP_TIMEOUT_MS,
    mintRunnerToken,
  } = await import('@agent-device/platform-apple/runner/operations');
  const { withAppleToolProvider, hasScopedAppleToolProvider, runXcrun } =
    await import('@agent-device/platform-apple/tool-provider');
  const { buildSimctlArgsForDevice } = await import('@agent-device/platform-apple/simctl');
  const lifetime = new AbortController();
  const withTools = <T>(task: () => Promise<T>, signal?: AbortSignal) =>
    withAppleToolProvider(createLimrunAppleToolProvider(session, lifetime.signal, signal), () =>
      withLimrunRunnerErrors(task),
    );
  const hostTools = withMethodScope({ ...appleApplications }, (task) =>
    hasScopedAppleToolProvider() ? task() : withTools(task),
  );
  const port = randomInt(20000, 50000);
  const apiUrl = session.apiUrl.replace(/\/$/, '');
  const commandUrl = new URL(`targetHttpPort${port}/command`, `${apiUrl}/../`).href;
  const headers = { Authorization: `Bearer ${session.token}` };
  let staging: string | undefined;
  let products: Promise<{ directory: string; bindAddress: string }> | undefined;
  let preparationController: AbortController | undefined;
  let preparationWaiters = 0;
  let prepared = false;
  let canceledRunMayHoldSlot = false;
  const endpoint = { port, token: mintRunnerToken(), http: { url: commandUrl, headers } };
  const provider = await createLaunchedAppleRunnerProvider(
    session.device,
    { endpoint, launch },
    host.env,
  );
  const { stop, release, prepare, isStarted, releaseSpeculative } = provider;
  const isReady = provider.hasLiveSession;
  const transport = await createAppleRunnerRuntime({ device: session.device, host, provider });

  const prepareProducts = async (callerSignal?: AbortSignal) => {
    const preparation = AbortSignal.any([lifetime.signal, ...(callerSignal ? [callerSignal] : [])]);
    staging = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-limrun-runner-'));
    const bindCommand = session.client.simctl(['getenv', 'booted', 'USE_IP']);
    const bindSignal = AbortSignal.any([preparation, AbortSignal.timeout(15_000)]);
    const bind = await awaitWithSignal(bindCommand.wait(), bindSignal).finally(() => {
      if (bindSignal.aborted) bindCommand.stop();
    });
    if (bind.code !== 0)
      throw limrunRunnerError('limrun_runner_bind_address_missing', 'Limrun did not expose USE_IP');
    const directory = await prepareLimrunRunnerProducts({
      directory: staging,
      version: readVersion(),
      appPath: host.env.AGENT_DEVICE_LIMRUN_IOS_RUNNER_APP,
      bindAddress: bind.stdout.trim(),
      endpoint,
      signal: preparation,
    });
    preparation.throwIfAborted();
    await uploadLimrunRunnerProducts(
      directory,
      apiUrl,
      session.token,
      AbortSignal.any([preparation, AbortSignal.timeout(300_000)]),
    );
    return { directory, bindAddress: bind.stdout.trim() };
  };
  const cachedProducts = async (
    signal?: AbortSignal,
  ): Promise<{ directory: string; bindAddress: string }> => {
    lifetime.signal.throwIfAborted();
    signal?.throwIfAborted();
    if (products && preparationController?.signal.aborted) {
      await awaitWithSignal(
        products.catch(() => {}),
        signal,
      );
      return await cachedProducts(signal);
    }
    emitDiagnostic({ level: 'info', phase: 'limrun.runner.prepare', data: { cached: prepared } });
    if (!products) {
      preparationController = new AbortController();
      products = prepareProducts(preparationController.signal)
        .then((value) => {
          prepared = true;
          return value;
        })
        .catch(async (error: unknown) => {
          if (staging) await fs.rm(staging, { recursive: true, force: true });
          staging = undefined;
          products = undefined;
          throw error;
        });
    }
    const pending = products;
    preparationWaiters++;
    try {
      return await awaitWithSignal(pending, signal);
    } finally {
      preparationWaiters--;
      // A shared upload belongs to its remaining waiters; the last canceled waiter drains it.
      if (signal?.aborted && preparationWaiters === 0 && !prepared) {
        preparationController?.abort(signal.reason);
        await pending.catch(() => {});
      }
    }
  };

  async function launch(
    ownedEndpoint: typeof endpoint,
    startupSignal: AbortSignal,
    deadline?: DeadlineClock,
  ) {
    const abort = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, abort.signal]);
    const cancel = () => abort.abort(startupSignal.reason);
    startupSignal.addEventListener('abort', cancel, { once: true });
    let response: Response;
    let runRequested = false;
    let lastConflict: AppError | undefined;
    try {
      startupSignal.throwIfAborted();
      const { directory, bindAddress } = await cachedProducts(signal);
      await writeLimrunRunnerConfiguration(directory, bindAddress, ownedEndpoint);
      await uploadLimrunRunnerProducts(directory, apiUrl, session.token, signal, [
        'Runner.xctestrun',
      ]);
      emitDiagnostic({
        level: 'info',
        phase: 'limrun.runner.launch',
        data: { path: '/xctest/run', port },
      });
      const remainingMs = deadline?.remainingMs() ?? 120_000;
      const launchTimeoutMs = Math.max(1, Math.floor(Math.min(90_000, remainingMs * 0.75)));
      const launchSignal = AbortSignal.any([signal, AbortSignal.timeout(launchTimeoutMs)]);
      response = await retryWithPolicy(
        async () => {
          runRequested = true;
          const result = await awaitWithSignal(
            fetch(`${apiUrl}/xctest/run`, {
              method: 'POST',
              headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                root: path.basename(directory),
                xctestrun: 'Runner.xctestrun',
              }),
              signal,
              redirect: 'error',
            }),
            launchSignal,
          );
          if (!result.ok) {
            const failure = limrunRunnerError(
              result.status === 409 ? 'limrun_xctest_slot_occupied' : 'limrun_runner_launch_failed',
              `Limrun XCTest launch failed (${result.status})`,
              {
                status: result.status,
                response: await awaitWithSignal(result.text(), launchSignal).catch(() => undefined),
              },
            );
            if (result.status === 409) lastConflict = failure;
            throw failure;
          }
          return result;
        },
        {
          maxAttempts: 90,
          baseDelayMs: 250,
          maxDelayMs: 1_000,
          shouldRetry: (error) =>
            canceledRunMayHoldSlot && error instanceof AppError && error.details?.status === 409,
        },
        {
          signal,
          // Leave time to report the last conflict before the shared start budget aborts.
          deadline: Deadline.fromTimeoutMs(Math.min(60_000, Math.max(0, remainingMs / 2))),
          phase: 'limrun.runner.wait_for_canceled_run',
        },
      );
      if (!response.body)
        throw limrunRunnerError(
          'limrun_runner_launch_failed',
          'Limrun XCTest launch returned no stream',
        );
      canceledRunMayHoldSlot = false;
    } catch (error) {
      // An interrupted HTTP request can reach the server before it returns the run stream.
      if (runRequested && !(error instanceof AppError && typeof error.details?.status === 'number'))
        canceledRunMayHoldSlot = true;
      const admissionExpired =
        !signal.aborted &&
        error instanceof AppError &&
        error.details?.reason === 'operation_deadline_expired';
      abort.abort(error);
      if (lastConflict && admissionExpired) throw lastConflict;
      throw error;
    } finally {
      startupSignal.removeEventListener('abort', cancel);
    }
    const reader = response.body!.getReader();
    let settle!: () => void;
    const exited = new Promise<void>((resolve) => {
      settle = resolve;
    });
    async function* output() {
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          yield decoder.decode(value, { stream: true });
        }
        yield decoder.decode();
      } catch (error) {
        canceledRunMayHoldSlot = true;
        if (!signal.aborted) throw error;
      } finally {
        settle();
      }
    }
    return {
      exited,
      output: output(),
      terminate: async () => {
        // Limrun releases its XCTest slot after it observes the closed stream.
        canceledRunMayHoldSlot = true;
        abort.abort();
        await reader.cancel().catch(() => {});
        settle();
        await exited;
      },
    };
  }

  const resetTarget = async (signal?: AbortSignal) => {
    try {
      await transport.resetTarget(signal);
    } catch (error) {
      await stop();
      throw error;
    }
  };
  const applicationTools = createLimrunAppleApplicationTools(
    session.device,
    {
      prepareCache: async (signal) => {
        await cachedProducts(signal);
      },
      prewarm: async (execution, signal, options) => {
        const input = { ...execution, signal, speculative: true };
        if (options?.healthCheck === false) {
          await provider.ensure(input);
          return;
        }
        await prepare(session.device, { ...input, healthTimeoutMs: RUNNER_STARTUP_TIMEOUT_MS });
      },
      prepare: (_device, input, signal) => transport.prepare(input, signal),
      resetTarget,
      isReady,
      release,
      isStarted,
      stop,
      releaseSpeculative,
    },
    hostTools,
  );
  return {
    applicationTools,
    bindDeployment: (request) =>
      withMethodScope({ ...transport.bindDeployment(request) }, (task) =>
        withTools(task, request.signal),
      ),
    facts: transport.facts,
    createInteractor: (context = {}) =>
      withMethodScope(transport.createInteractor(context), (task) =>
        withTools(task, context.signal),
      ),
    bindRunnerOperations: transport.bindRunnerOperations,
    bindApplicationLifecycle: (request) => {
      const lifecycle = transport.bindApplicationLifecycle({
        ...request,
        appleApplications: applicationTools,
        ensureReady: async (device, signal, options) => {
          await runXcrun(buildSimctlArgsForDevice(device, ['bootstatus', device.id, '-b']), {
            signal,
            ...(options?.deadlineAtMs === undefined
              ? {}
              : {
                  timeoutMs: Math.max(1, options.deadlineAtMs - Date.now()),
                }),
          });
          return { ...device, booted: true };
        },
      });
      return withMethodScope({ ...lifecycle }, (task) => withTools(task, request.signal));
    },
    resetTarget,
    dispose: async () => {
      try {
        await applicationTools.finalizeRunnerSessionsForShutdown();
      } finally {
        lifetime.abort();
        await products?.catch(() => {});
        if (staging) await fs.rm(staging, { recursive: true, force: true });
      }
    },
  };
}
