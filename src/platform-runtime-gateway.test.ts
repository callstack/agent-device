import fs from 'node:fs';
import {
  type DeviceBinding,
  localRuntimeOwner,
  providerRuntimeOwner,
} from '@agent-device/contracts/platform-runtime';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
} from '@agent-device/contracts/platform-runtime-operations';
import { applicationLifecycleOperationFacts } from '@agent-device/contracts/application-lifecycle-runtime';
import { createUnavailablePlatformRuntimeFacts } from '@agent-device/contracts/platform-runtime-unavailable';
import { screenshotRuntimeOperationFacts } from '@agent-device/contracts/screenshot-runtime';
import { viewportRuntimeOperationFacts } from '@agent-device/contracts/viewport-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { createLimrunRuntime } from '@agent-device/provider-limrun';
import { describe, expect, expectTypeOf, test, vi } from 'vitest';
import type { AgentDeviceHost } from './sdk/host-types.ts';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { startDaemonRuntime } from '@agent-device/daemon';
import { composeDaemonRuntimeDeps } from './daemon-composition.ts';
import { createComposedPlatformRuntimeGateway } from './platform-runtime-gateway.ts';
import {
  gatewayFixture as gateway,
  gatewayFixtureDevice as device,
  gatewayFixtureScope as scope,
  LIFECYCLE_FACETS,
  limrunTestDependencies,
  providerLifecycleOwnerFixture as providerLifecycleOwner,
  providerRuntimeFixture as providerRuntime,
  runtimeOwnerFixture as runtimeOwner,
} from './platform-runtime-gateway.fixtures.ts';

describe('composed platform runtime gateway', () => {
  test('the SDK close report exposes each platform owner outcome', () => {
    expectTypeOf<Awaited<ReturnType<AgentDeviceHost['close']>>['platformOwners']>().toEqualTypeOf<
      'closed' | 'pending' | 'failed'
    >();
  });

  test('shutdown waits for an owner load already in progress', async () => {
    const ref = providerRuntimeOwner('limrun', 'loading');
    const shutdown = vi.fn(async () => {});
    let finishLoad!: () => void;
    const loadReady = new Promise<void>((resolve) => {
      finishLoad = resolve;
    });
    const registration = providerRuntime({
      ref,
      load: async () => {
        await loadReady;
        return { ...runtimeOwner({ ref }), shutdown };
      },
    });
    const runtimeGateway = gateway([registration]);
    const binding = runtimeGateway.bind({
      device,
      intent: { kind: 'exact-owner', owner: ref, fence: { token: 'fence', generation: 1 } },
      scope,
    });
    const closing = runtimeGateway.shutdown();
    finishLoad();
    await binding;
    await closing;
    expect(shutdown).toHaveBeenCalledOnce();
  });
  test('an unfinished owner load does not delay shutdown of a loaded owner', async () => {
    const readyRef = providerRuntimeOwner('limrun', 'ready');
    const loadingRef = providerRuntimeOwner('limrun', 'loading');
    const readyShutdown = vi.fn(async () => {});
    const lateShutdown = vi.fn(async () => {});
    let finishLoad!: () => void;
    const loadReady = new Promise<void>((resolve) => {
      finishLoad = resolve;
    });
    const runtimeGateway = gateway([
      providerRuntime({
        ref: readyRef,
        load: async () => ({ ...runtimeOwner({ ref: readyRef }), shutdown: readyShutdown }),
      }),
      providerRuntime({
        ref: loadingRef,
        load: async () => {
          await loadReady;
          return { ...runtimeOwner({ ref: loadingRef }), shutdown: lateShutdown };
        },
      }),
    ]);
    await runtimeGateway.bind({
      device,
      intent: { kind: 'exact-owner', owner: readyRef, fence: { token: 'ready', generation: 1 } },
      scope,
    });
    const loading = runtimeGateway.bind({
      device,
      intent: {
        kind: 'exact-owner',
        owner: loadingRef,
        fence: { token: 'loading', generation: 1 },
      },
      scope,
    });
    const closing = runtimeGateway.shutdown();
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(readyShutdown).toHaveBeenCalledOnce();
      expect(lateShutdown).not.toHaveBeenCalled();
    } finally {
      finishLoad();
      await loading;
      await closing;
    }
    expect(readyShutdown).toHaveBeenCalledOnce();
    expect(lateShutdown).toHaveBeenCalledOnce();
  });
  test('daemon reports a composed owner failure and retains registration while completing cleanup', async () => {
    const ref = providerRuntimeOwner('limrun', 'failed');
    const shutdown = vi.fn(async () => {
      throw new AppError('COMMAND_FAILED', 'owner refused', {
        reason: 'owner-test-refusal',
        hint: 'Inspect the original owner failure.',
      });
    });
    const registration = providerRuntime({
      ref,
      load: async () => ({ ...runtimeOwner({ ref }), shutdown }),
    });
    const composed = gateway([registration]);
    await composed.bind({
      device,
      intent: { kind: 'exact-owner', owner: ref, fence: { token: 'fence', generation: 1 } },
      scope,
    });
    const stateDir = mkdtempForTestSync('agent-device-owner-failure-');
    const paths = resolveDaemonPaths(stateDir);
    const finalize = vi.fn(async () => ['runner']);
    const pluginClose = vi.fn(async () => []);
    const clearLock = vi.fn(async () => {});
    const runtime = await startDaemonRuntime({
      host: createTestHostEnvironment({
        env: {
          ...process.env,
          AGENT_DEVICE_STATE_DIR: stateDir,
          AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
          AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
        },
      }),
      stderr: { write: () => {} },
      stdout: { write: () => {} },
      composeDeps: async (input) => {
        const deps = await composeDaemonRuntimeDeps(input, []);
        const applicationLifecycle = deps.deviceRuntimeGateway.applicationLifecycle;
        if (!applicationLifecycle)
          throw new Error('Root composition must supply application lifecycle');
        return {
          ...deps,
          deviceRuntimeGateway: {
            ...composed,
            applicationLifecycle: {
              ...applicationLifecycle,
              finalizeDaemonShutdown: finalize,
            },
          },
          shutdownProviderRuntimes: pluginClose,
          ownerLifecycle: { ...deps.ownerLifecycle, clearDaemonLockConfiguration: clearLock },
        };
      },
    });
    const report = await runtime.close();
    expect(report.platformOwners).toBe('failed');
    expect(report.runners.stopped).toEqual(['runner']);
    const log = fs.readFileSync(paths.logPath, 'utf8');
    const diagnostic = log
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find(({ phase }) => phase === 'daemon_shutdown_platform_owner_failed');
    expect(diagnostic.data.error).toMatchObject({
      code: 'COMMAND_FAILED',
      details: {
        reason: 'platform-owner-shutdown-failed',
        failures: [{ owner: ref, error: { code: 'COMMAND_FAILED', message: 'owner refused' } }],
      },
    });
    expect(diagnostic.data).not.toHaveProperty('failures');
    expect(log).toContain('daemon_shutdown_platform_owner_failed');
    expect(log).toContain('owner refused');
    expect(log).toContain('owner-test-refusal');
    expect(log).toContain('Inspect the original owner failure.');
    expect(fs.existsSync(paths.infoPath)).toBe(true);
    expect(fs.existsSync(paths.lockPath)).toBe(true);
    expect(clearLock).not.toHaveBeenCalled();
    expect(pluginClose).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledOnce();
    expect(await runtime.close()).toBe(report);
    expect(shutdown).toHaveBeenCalledOnce();
  });
  test.each([1, 2] as const)(
    'settles all owners and preserves %i failure(s) across concurrent and repeated shutdown',
    async (failureCount) => {
      const failedRef = providerRuntimeOwner('limrun', 'failed');
      const secondFailedRef = providerRuntimeOwner('limrun', 'second-failed');
      const healthyRef = providerRuntimeOwner('limrun', 'healthy');
      const failure = new Error('owner refused');
      const failedShutdown = vi.fn(async () => {
        throw failure;
      });
      const secondFailure = new AppError('TOOL_MISSING', 'owner tool missing', {
        reason: 'owner-tool-missing',
        hint: 'Inspect owner tooling.',
        diagnosticId: 'owner-tool-diagnostic',
      });
      const secondShutdown = vi.fn(async () => {
        throw secondFailure;
      });
      const healthyShutdown = vi.fn(async () => {});
      const failed = providerRuntime({
        ref: failedRef,
        load: async () => ({ ...runtimeOwner({ ref: failedRef }), shutdown: failedShutdown }),
      });
      const healthy = providerRuntime({
        ref: healthyRef,
        load: async () => ({ ...runtimeOwner({ ref: healthyRef }), shutdown: healthyShutdown }),
      });
      const secondFailed = providerRuntime({
        ref: secondFailedRef,
        load: async () => ({ ...runtimeOwner({ ref: secondFailedRef }), shutdown: secondShutdown }),
      });
      const runtimeGateway = gateway(
        failureCount === 1 ? [failed, healthy] : [failed, secondFailed, healthy],
      );
      for (const ref of failureCount === 1
        ? [failedRef, healthyRef]
        : [failedRef, secondFailedRef, healthyRef]) {
        await runtimeGateway.bind({
          device,
          intent: { kind: 'exact-owner', owner: ref, fence: { token: 'fence', generation: 1 } },
          scope,
        });
      }

      const first = runtimeGateway.shutdown();
      const second = runtimeGateway.shutdown();
      const results = await Promise.allSettled([first, second]);
      for (const result of results) {
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected') {
          expect(result.reason).toBeInstanceOf(AppError);
          expect(normalizeError(result.reason)).toMatchObject({
            code: 'COMMAND_FAILED',
            retriable: false,
            details: {
              reason: 'platform-owner-shutdown-failed',
              failures: [
                {
                  owner: failedRef,
                  error: expect.objectContaining({ code: 'UNKNOWN', message: 'owner refused' }),
                },
                ...(failureCount === 2
                  ? [
                      {
                        owner: secondFailedRef,
                        error: expect.objectContaining({
                          code: 'TOOL_MISSING',
                          hint: 'Inspect owner tooling.',
                          diagnosticId: 'owner-tool-diagnostic',
                        }),
                      },
                    ]
                  : []),
              ],
            },
          });
          if (failureCount === 1) expect(result.reason.cause).toBe(failure);
          else expect(result.reason.cause.errors).toEqual([failure, secondFailure]);
        }
      }
      await expect(runtimeGateway.shutdown()).rejects.toBe(
        (results[0] as PromiseRejectedResult).reason,
      );
      expect(failedShutdown).toHaveBeenCalledOnce();
      expect(healthyShutdown).toHaveBeenCalledOnce();
      expect(secondShutdown).toHaveBeenCalledTimes(failureCount === 2 ? 1 : 0);
      await expect(
        runtimeGateway.bind({
          device,
          intent: {
            kind: 'exact-owner',
            owner: healthyRef,
            fence: { token: 'fence', generation: 1 },
          },
          scope,
        }),
      ).rejects.toMatchObject({
        code: 'COMMAND_FAILED',
        details: { reason: 'runtime-contract-invalid' },
      });
    },
  );
  test('loads only the selected Apple owner for screenshot facts and binding', async () => {
    const appleDevice: DeviceInfo = {
      platform: 'apple',
      appleOs: 'ios',
      id: 'ios-simulator',
      name: 'iPhone',
      kind: 'simulator',
      target: 'mobile',
      booted: true,
    };
    const unavailable = { available: false, reason: 'unsupported-platform-leaf' } as const;
    const owner = localRuntimeOwner('apple');
    const baseFacts = createUnavailablePlatformRuntimeFacts(appleDevice, owner, {
      appLog: unavailable,
      network: unavailable,
      screenshot: unavailable,
      elementText: unavailable,
      viewport: unavailable,
      focus: unavailable,
      gesture: unavailable,
      scroll: unavailable,
      typeText: unavailable,
      back: unavailable,
      orientation: unavailable,
      tvRemote: unavailable,
      keyboard: unavailable,
      clipboard: unavailable,
      systemButton: unavailable,
      fold: unavailable,
      telephony: unavailable,
      triggerAppEvent: unavailable,
      settings: unavailable,
      readAlert: unavailable,
      awaitAlert: unavailable,
      acceptAlert: unavailable,
      dismissAlert: unavailable,
      touch: unavailable,
      audioProbeCapture: unavailable,
      audioProbeQuery: unavailable,
      lifecycle: applicationLifecycleOperationFacts({
        resolveOpenTarget: unavailable,
        prepareApplicationOpen: unavailable,
        openApplication: unavailable,
        applyRuntimeHints: unavailable,
        clearRuntimeHints: unavailable,
        closeApplication: unavailable,
        finalizeApplicationClose: unavailable,
        prepareAppleRunner: unavailable,
        configureProviderPortReverse: unavailable,
      }),
    });
    const facts = {
      ...baseFacts,
      operations: {
        ...baseFacts.operations,
        ...screenshotRuntimeOperationFacts({ capture: { available: true } }),
      },
    };
    const captureScreenshot = vi.fn(async () => ({}));
    const binding: DeviceBinding<PlatformRuntimeOperations> = {
      device: appleDevice,
      owner,
      facts,
      operations: { captureScreenshot },
      [Symbol.asyncDispose]: async () => {},
    };
    const appleLoad = vi.fn(async () => ({
      owner,
      ownsDevice: () => true,
      inspectFacts: async () => facts,
      bind: async () => binding,
      shutdown: async () => {},
    }));
    const webLoad = vi.fn(async () => {
      throw new Error('unselected web runtime must stay lazy');
    });
    const runtimeGateway = createComposedPlatformRuntimeGateway({
      modules: new Map([
        ['apple', { family: 'apple', loadRuntime: appleLoad }],
        ['web', { family: 'web', loadRuntime: webLoad }],
      ]),
      loadHost: async () => ({}) as PlatformRuntimeHost,
    });

    await expect(runtimeGateway.inspectFacts(appleDevice)).resolves.toMatchObject({
      operations: { captureScreenshot: { available: true } },
    });
    const selected = await runtimeGateway.bind({
      device: appleDevice,
      intent: { kind: 'ordinary' },
      scope,
    });
    await selected.operations.captureScreenshot?.({ outPath: '/tmp/gateway.png' });
    expect(appleLoad).toHaveBeenCalledTimes(1);
    expect(webLoad).not.toHaveBeenCalled();
    expect(captureScreenshot).toHaveBeenCalledWith({ outPath: '/tmp/gateway.png' });
  });

  test('loads only the selected web owner for viewport facts and binding', async () => {
    const webDevice: DeviceInfo = {
      platform: 'web',
      id: 'web',
      name: 'Web',
      kind: 'device',
      target: 'desktop',
      booted: true,
    };
    const unavailable = { available: false, reason: 'unsupported-platform-leaf' } as const;
    const available = { available: true } as const;
    const owner = localRuntimeOwner('web');
    const baseFacts = createUnavailablePlatformRuntimeFacts(webDevice, owner, {
      appLog: unavailable,
      network: unavailable,
      screenshot: unavailable,
      viewport: unavailable,
      focus: unavailable,
      gesture: unavailable,
      scroll: unavailable,
      typeText: unavailable,
      touch: unavailable,
      elementText: unavailable,
      back: unavailable,
      orientation: unavailable,
      tvRemote: unavailable,
      keyboard: unavailable,
      clipboard: unavailable,
      systemButton: unavailable,
      fold: unavailable,
      telephony: unavailable,
      triggerAppEvent: unavailable,
      settings: unavailable,
      readAlert: unavailable,
      awaitAlert: unavailable,
      acceptAlert: unavailable,
      dismissAlert: unavailable,
      audioProbeCapture: unavailable,
      audioProbeQuery: unavailable,
      lifecycle: applicationLifecycleOperationFacts({
        resolveOpenTarget: unavailable,
        prepareApplicationOpen: unavailable,
        openApplication: unavailable,
        applyRuntimeHints: unavailable,
        clearRuntimeHints: unavailable,
        closeApplication: unavailable,
        finalizeApplicationClose: unavailable,
        prepareAppleRunner: unavailable,
        configureProviderPortReverse: unavailable,
      }),
    });
    const facts = {
      ...baseFacts,
      operations: {
        ...baseFacts.operations,
        ...viewportRuntimeOperationFacts({ setViewport: available }),
      },
    };
    const setViewport = vi.fn(async () => undefined);
    const binding: DeviceBinding<PlatformRuntimeOperations> = {
      device: webDevice,
      owner,
      facts,
      operations: { setViewport },
      [Symbol.asyncDispose]: async () => {},
    };
    const webLoad = vi.fn(async () => ({
      owner,
      ownsDevice: () => true,
      inspectFacts: async () => facts,
      bind: async () => binding,
      shutdown: async () => {},
    }));
    const appleLoad = vi.fn(async () => {
      throw new Error('unselected Apple runtime must stay lazy');
    });
    const runtimeGateway = createComposedPlatformRuntimeGateway({
      modules: new Map([
        ['web', { family: 'web', loadRuntime: webLoad }],
        ['apple', { family: 'apple', loadRuntime: appleLoad }],
      ]),
      loadHost: async () => ({}) as PlatformRuntimeHost,
    });

    await expect(runtimeGateway.inspectFacts(webDevice)).resolves.toMatchObject({
      operations: { setViewport: { available: true } },
    });
    const selected = await runtimeGateway.bind({
      device: webDevice,
      intent: { kind: 'ordinary' },
      scope,
    });
    await selected.operations.setViewport?.({ width: 1280, height: 900 });
    expect(webLoad).toHaveBeenCalledTimes(1);
    expect(appleLoad).not.toHaveBeenCalled();
    expect(setViewport).toHaveBeenCalledWith({ width: 1280, height: 900 });
  });

  // Which resources need recovering is the host's composition (see
  // platform-runtime-application-resources.test.ts). The gateway owns only the lazy host load and
  // the once-per-process shape of each durable phase.
  test('durable lifecycle phases load the host lazily and run once per process', async () => {
    const recoverStartupResources = vi.fn(async () => {});
    const detachForDaemonShutdown = vi.fn(async () => {});
    const finalizeDaemonShutdown = vi.fn(async () => {});
    const host = {
      applicationResources: {
        recoverStartupResources,
        detachForDaemonShutdown,
        finalizeDaemonShutdown,
      },
    } as unknown as PlatformRuntimeHost;
    const loadHost = vi.fn(async () => host);
    const runtimeGateway = createComposedPlatformRuntimeGateway({
      modules: new Map(),
      loadHost,
    });
    const lifecycle = runtimeGateway.applicationLifecycle;
    if (!lifecycle) throw new Error('expected the composed lifecycle gateway');
    const stateDir = `/tmp/platform-runtime-marker-evidence-${Date.now()}`;

    await lifecycle.recoverStartupResources({ stateDir });

    expect(loadHost).toHaveBeenCalledOnce();
    expect(recoverStartupResources).toHaveBeenCalledExactlyOnceWith({ stateDir });

    await lifecycle.detachForDaemonShutdown();
    await lifecycle.detachForDaemonShutdown();
    await lifecycle.finalizeDaemonShutdown();
    await lifecycle.finalizeDaemonShutdown();

    expect(detachForDaemonShutdown).toHaveBeenCalledOnce();
    expect(finalizeDaemonShutdown).toHaveBeenCalledOnce();
  });

  test('inspects only the selected lazy owner and does not bind it', async () => {
    const selectedRef = providerRuntimeOwner('limrun', 'selected');
    const selectedOwner = runtimeOwner({ ref: selectedRef });
    const inspectFacts = vi.spyOn(selectedOwner, 'inspectFacts');
    const bind = vi.spyOn(selectedOwner, 'bind');
    const unrelatedLoad = vi.fn(async () => {
      throw new Error('must stay lazy');
    });
    const runtimeGateway = gateway([
      providerRuntime({
        ref: providerRuntimeOwner('limrun', 'unrelated'),
        ownsDevice: () => false,
        load: unrelatedLoad,
      }),
      providerRuntime({ ref: selectedRef, load: async () => selectedOwner }),
    ]);

    await expect(runtimeGateway.inspectFacts(device)).resolves.toMatchObject({
      operations: { ensureReady: { available: false } },
    });

    expect(inspectFacts).toHaveBeenCalledOnce();
    expect(bind).not.toHaveBeenCalled();
    expect(unrelatedLoad).not.toHaveBeenCalled();
  });

  test('keeps a stale Limrun Android id unavailable without binding or local fallback', async () => {
    const registration = createLimrunRuntime(
      { apiKey: 'test-key', runtimeInstance: 'test-instance' },
      limrunTestDependencies,
      { includePlatformModule: true },
    );
    const staleDevice: DeviceInfo = {
      platform: 'android',
      id: 'limrun:android:released-lease',
      name: 'Released Limrun Android',
      kind: 'emulator',
      target: 'mobile',
      booted: true,
    };
    let inspectCount = 0;
    let bindCount = 0;
    const providerModule = {
      ...registration.platformModule,
      loadRuntime: async (host: PlatformRuntimeHost) => {
        const owner = await registration.platformModule.loadRuntime(host);
        return {
          ...owner,
          inspectFacts: async (device: DeviceInfo) => {
            inspectCount += 1;
            return await owner.inspectFacts(device);
          },
          bind: async (request: Parameters<PlatformRuntimeOwner['bind']>[0]) => {
            bindCount += 1;
            return await owner.bind(request);
          },
        };
      },
    };
    const localLoad = vi.fn(async () => {
      throw new Error('stale Limrun identity must not fall back to local Android');
    });
    const runtimeGateway = createComposedPlatformRuntimeGateway({
      modules: new Map([['android', { family: 'android', loadRuntime: localLoad }]]),
      loadHost: async () => ({}) as PlatformRuntimeHost,
      providerRuntimes: [registration.runtime],
      providerModules: [{ runtime: registration.runtime, module: providerModule }],
    });

    try {
      const facts = await runtimeGateway.inspectFacts(staleDevice);
      expect(facts.operations.appState).toMatchObject({
        available: false,
        reason: 'owner-capability-missing',
        hint: 'Limrun requires a matching live provider session for this device.',
      });
      expect(inspectCount).toBe(1);
      expect(bindCount).toBe(0);
      expect(localLoad).not.toHaveBeenCalled();
    } finally {
      await runtimeGateway.shutdown();
      await registration.runtime.shutdown();
    }
  });

  test('rejects inspected facts with a provider-mode mismatch', async () => {
    const ref = providerRuntimeOwner('limrun', 'stable');
    await expect(
      gateway([providerRuntime({ ref, mismatch: 'facts' })]).inspectFacts(device),
    ).rejects.toMatchObject({ details: { reason: 'runtime-contract-invalid' } });
  });

  test('selects an exact provider owner without ordinary ownsDevice arbitration', async () => {
    const ownsDevice = vi.fn(() => false);
    const ref = providerRuntimeOwner('limrun', 'stable');
    const runtime = providerRuntime({ ref, ownsDevice });
    const runtimeGateway = gateway([runtime]);

    const binding = await runtimeGateway.bind({
      device,
      intent: { kind: 'exact-owner', owner: ref, fence: { token: 'fence', generation: 1 } },
      scope,
    });
    expect(binding.owner).toEqual(ref);
    expect(ownsDevice).not.toHaveBeenCalled();
  });

  test('rejects ambiguous ordinary provider ownership', async () => {
    const first = providerRuntime({
      provider: 'first',
      ref: providerRuntimeOwner('first', 'stable'),
      ownsDevice: () => true,
    });
    const second = providerRuntime({
      provider: 'second',
      ref: providerRuntimeOwner('second', 'stable'),
      ownsDevice: () => true,
    });
    await expect(
      gateway([first, second]).bind({ device, intent: { kind: 'ordinary' }, scope }),
    ).rejects.toMatchObject({ details: { reason: 'runtime-contract-invalid' } });
  });

  test('rejects duplicate stable provider owner refs', async () => {
    const ref = providerRuntimeOwner('limrun', 'stable');
    expect(() => gateway([providerRuntime({ ref }), providerRuntime({ ref })])).toThrow(
      'Duplicate platform runtime owner',
    );
  });

  test('loads only the exact provider instance selected by stable owner metadata', async () => {
    const target = providerRuntimeOwner('limrun', 'target');
    const unrelatedLoad = vi.fn(async () => {
      throw new Error('must stay lazy');
    });
    const runtimeGateway = gateway([
      providerRuntime({ ref: providerRuntimeOwner('limrun', 'other'), load: unrelatedLoad }),
      providerRuntime({ ref: target, ownsDevice: () => false }),
    ]);
    await expect(
      runtimeGateway.bind({
        device,
        intent: { kind: 'exact-owner', owner: target, fence: { token: 'fence', generation: 1 } },
        scope,
      }),
    ).resolves.toMatchObject({ owner: target });
    expect(unrelatedLoad).not.toHaveBeenCalled();
  });

  test('does not fall back to a local runtime for a provider without an app-log module', async () => {
    const hostLoad = vi.fn(async () => ({}) as PlatformRuntimeHost);
    const localLoad = vi.fn(async () =>
      runtimeOwner({ ref: { kind: 'local-family', family: 'apple' } }),
    );
    const runtimeGateway = createComposedPlatformRuntimeGateway({
      modules: new Map([['apple', { family: 'apple', loadRuntime: localLoad }]]),
      loadHost: hostLoad,
      providerRuntimes: [
        {
          provider: 'webdriver',
          leaseLifecycle: {},
          deviceInventoryProvider: async () => null,
          ownsDevice: () => true,
          getInteractor: () => undefined,
          shutdown: async () => {},
        },
      ],
    });
    const binding = await runtimeGateway.bind({ device, intent: { kind: 'ordinary' }, scope });
    expect(binding.facts.operations.appLogInspect).toMatchObject({
      available: false,
      reason: 'unsupported-provider-mode',
    });
    expect(binding.facts.operations.listApps).toMatchObject({
      available: false,
      reason: 'unsupported-provider-mode',
    });
    expect(binding.facts.operations.appState).toMatchObject({
      available: false,
      reason: 'unsupported-provider-mode',
    });
    expect(hostLoad).not.toHaveBeenCalled();
    expect(localLoad).not.toHaveBeenCalled();
    const inspected = await runtimeGateway.inspectFacts(device);
    // The bind and inspect arms build this fact set independently; both must derive from the same
    // construction path rather than two hand-maintained maps that can drift from each other.
    expect(binding.facts).toStrictEqual(inspected);
  });

  test.each(LIFECYCLE_FACETS)(
    'keeps provider-owned unsupported $0 operations closed without loading a local runtime',
    async (facet, operations) => {
      const ref = providerRuntimeOwner('webdriver', `unsupported-${facet}`);
      const owner = providerLifecycleOwner(ref, facet);
      const localLoad = vi.fn(async () => {
        throw new Error('local lifecycle fallback must not load');
      });
      const registration = providerRuntime({
        ref,
        provider: 'webdriver',
        ownsDevice: () => true,
        load: async () => owner,
      });
      const runtimeGateway = createComposedPlatformRuntimeGateway({
        modules: new Map([['apple', { family: 'apple', loadRuntime: localLoad }]]),
        loadHost: async () => ({}) as PlatformRuntimeHost,
        providerRuntimes: [registration.runtime],
        providerModules: [registration],
      });

      const facts = await runtimeGateway.inspectFacts(device);
      expect(facts.operations.captureScreenshot).toMatchObject({
        available: false,
        reason: 'owner-capability-missing',
      });
      expect(facts.operations.appLogInspect).toMatchObject({
        available: false,
        reason: 'unsupported-provider-mode',
      });
      for (const operation of operations) {
        expect(facts.operations[operation].available).toBe(false);
      }
      const binding = await runtimeGateway.bind({ device, intent: { kind: 'ordinary' }, scope });
      expect(binding.owner).toEqual(ref);
      for (const operation of operations) {
        expect(binding.operations[operation]).toBeUndefined();
      }
      expect(localLoad).not.toHaveBeenCalled();
    },
  );

  test('rejects a swapped local module before loading host mechanics', async () => {
    const hostLoad = vi.fn(async () => ({}) as PlatformRuntimeHost);
    const runtimeGateway = createComposedPlatformRuntimeGateway({
      modules: new Map([
        [
          'apple',
          {
            family: 'android',
            loadRuntime: async () =>
              runtimeOwner({ ref: { kind: 'local-family', family: 'android' } }),
          },
        ],
      ]),
      loadHost: hostLoad,
    });
    await expect(
      runtimeGateway.bind({ device, intent: { kind: 'ordinary' }, scope }),
    ).rejects.toMatchObject({ details: { reason: 'runtime-contract-invalid' } });
    expect(hostLoad).not.toHaveBeenCalled();
  });

  test('accepts transport-composed facts from the selected local family owner', async () => {
    const ref = { kind: 'local-family', family: 'apple' } as const;
    const runtimeGateway = createComposedPlatformRuntimeGateway({
      modules: new Map([
        [
          'apple',
          {
            family: 'apple',
            loadRuntime: async () => runtimeOwner({ ref, providerMode: 'transport-composed' }),
          },
        ],
      ]),
      loadHost: async () => ({}) as PlatformRuntimeHost,
    });

    await expect(
      runtimeGateway.bind({ device, intent: { kind: 'ordinary' }, scope }),
    ).resolves.toMatchObject({
      owner: ref,
      facts: { device: { providerMode: 'transport-composed' } },
    });
  });

  test.each(['owner', 'device', 'facts'] as const)(
    'disposes a provider binding with mismatched %s identity',
    async (mismatch) => {
      const disposed = vi.fn(async () => {});
      const ref = providerRuntimeOwner('limrun', 'stable');
      const runtime = providerRuntime({ ref, mismatch, disposed });
      await expect(
        gateway([runtime]).bind({
          device,
          intent: { kind: 'exact-owner', owner: ref, fence: { token: 'fence', generation: 1 } },
          scope,
        }),
      ).rejects.toMatchObject({ details: { reason: 'runtime-contract-invalid' } });
      expect(disposed).toHaveBeenCalledOnce();
    },
  );
});
