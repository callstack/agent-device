import { expect, test } from 'vitest';
import { bindAppleApplicationLifecycle } from './lifecycle.ts';
import { coldSimulatorLifecycleHost, openInput, simulator } from './lifecycle.fixtures.ts';

const shutdownSimulator = { ...simulator, booted: false };
const readiedSimulator = { ...simulator, booted: true };

const prepareOpenInput = {
  target: 'com.example.app',
  hasExistingSession: false,
  surface: 'app' as const,
  prewarmRunnerOnColdBoot: false,
  execution: {},
};

test('an open on a Shutdown Simulator hands the readied device to the interactor and the runner prewarm', async () => {
  const { host, calls, prewarmRunnerSession, resolveInteractor } = coldSimulatorLifecycleHost();
  const signal = new AbortController().signal;
  const lifecycle = bindAppleApplicationLifecycle({ host, device: shutdownSimulator, signal });

  await lifecycle.prepareApplicationOpen(prepareOpenInput);
  await lifecycle.openApplication(openInput());

  expect(resolveInteractor).toHaveBeenCalled();
  expect(resolveInteractor.mock.calls.every(([resolved]) => resolved.booted)).toBe(true);
  expect(prewarmRunnerSession).toHaveBeenCalledWith(readiedSimulator, {}, signal, false);
  expect(calls.filter((call) => call.args.includes('bootstatus'))).toHaveLength(1);
  expect(shutdownSimulator.booted).toBe(false);
});

test('explicit runner preparation prepares the readied device and later opens reuse it', async () => {
  const { host, prepareRunner, prewarmRunnerSession } = coldSimulatorLifecycleHost();
  const signal = new AbortController().signal;
  const lifecycle = bindAppleApplicationLifecycle({ host, device: shutdownSimulator, signal });

  await lifecycle.prepareAppleRunner({ timeoutMs: 100_000, execution: {} });
  await lifecycle.openApplication(openInput());

  expect(prepareRunner).toHaveBeenCalledWith(readiedSimulator, expect.anything(), signal);
  expect(prewarmRunnerSession).toHaveBeenCalledWith(readiedSimulator, {}, signal, false);
});

test('a close that readies a Shutdown Simulator hands the readied device to the interactor', async () => {
  const { host, calls, resolveInteractor } = coldSimulatorLifecycleHost();
  const lifecycle = bindAppleApplicationLifecycle({
    host,
    device: shutdownSimulator,
    signal: new AbortController().signal,
  });

  await lifecycle.closeApplication({
    appBundleId: 'com.example.app',
    positionals: ['com.example.app'],
    surface: 'app',
    ensureReady: true,
    execution: {},
  });

  expect(resolveInteractor).toHaveBeenCalledTimes(1);
  expect(resolveInteractor.mock.calls[0]?.[0]).toMatchObject({ booted: true });
  expect(calls.filter((call) => call.args.includes('bootstatus'))).toHaveLength(1);
});

test('a failed preparation leaves the original device bound', async () => {
  const { host, prewarmRunnerSession } = coldSimulatorLifecycleHost({ bootstatusExitCode: 1 });
  const signal = new AbortController().signal;
  const lifecycle = bindAppleApplicationLifecycle({ host, device: shutdownSimulator, signal });

  await expect(lifecycle.prepareApplicationOpen(prepareOpenInput)).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
  });
  await lifecycle.openApplication(openInput());

  expect(prewarmRunnerSession).toHaveBeenCalledWith(shutdownSimulator, {}, signal, false);
});

test('a cancelled runner preparation prepares nothing and leaves the original device bound', async () => {
  const controller = new AbortController();
  const { host, prepareRunner, prewarmRunnerSession } = coldSimulatorLifecycleHost({
    onBootstatus: () => controller.abort(new Error('cancelled')),
  });
  const lifecycle = bindAppleApplicationLifecycle({
    host,
    device: shutdownSimulator,
    signal: controller.signal,
  });

  await expect(lifecycle.prepareAppleRunner({ timeoutMs: 100_000, execution: {} })).rejects.toThrow(
    'cancelled',
  );

  expect(prepareRunner).not.toHaveBeenCalled();
  expect(prewarmRunnerSession).not.toHaveBeenCalled();
});
