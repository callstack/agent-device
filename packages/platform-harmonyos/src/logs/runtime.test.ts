import type { AppLogRuntimeHost } from '@agent-device/contracts/app-log-runtime';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { expect, test } from 'vitest';
import path from 'node:path';
import {
  createHarmonyHostStub,
  createHarmonyToolchainRoot,
  harmonyCommandPath,
} from '../toolbox.fixtures.ts';
import { createHarmonyAppLogEnvelope, harmonyAppLogDescriptorCodec } from './descriptor.ts';
import { createHarmonyAppLogRuntime } from './runtime.ts';

const device: DeviceInfo = {
  platform: 'harmonyos',
  id: 'harmony-1',
  name: 'Harmony',
  kind: 'device',
  target: 'mobile',
  booted: true,
};
const scope: PlatformRequestScope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => {} },
  progress: { report: () => {} },
};

const MISSING_HDC = 'hdc not found in PATH';
const MISSING_HDC_HINT =
  'Install HarmonyOS Command Line Tools, then add its sdk/default/openharmony/toolchains directory to PATH or set HDC_SDK_PATH.';

/** The app-scoped `logs start` input every start test uses. */
const startInput = {
  sessionId: 'session',
  appBundleId: 'com.example.harmony',
  outputPath: '/tmp/app.log',
  fence: { token: 'fence', generation: 1 },
};

test('rejects durable HarmonyOS descriptors without the canonical process marker', () => {
  expect(
    harmonyAppLogDescriptorCodec.decode({
      transport: 'harmony-hilog',
      outputPath: '/tmp/app.log',
    }),
  ).toMatchObject({ status: 'invalid' });
});

test('starts HarmonyOS hilog with the resolved application pid', async () => {
  const fixture = hostFixture();
  const binding = await createHarmonyAppLogRuntime(fixture.host, fixture.toolbox).bind({
    device,
    intent: { kind: 'ordinary' },
    scope,
  });
  const started = await binding.operations.appLogStart?.(startInput);

  // The PID lookup is an HDC command: the one-shot route asked for `pidof`, and the stream is the
  // managed background command the same host started.
  expect(fixture.hdcCommands()).toEqual([
    ['-t', 'harmony-1', 'shell', 'pidof', 'com.example.harmony'],
  ]);
  expect(fixture.streams).toHaveLength(1);
  expect(fixture.streams[0]!.args).toEqual(['-t', 'harmony-1', 'shell', 'hilog', '-P', '456']);
  expect(await started?.pendingHandle.transfer().finish()).toMatchObject({
    status: 'completed',
    result: { backend: 'harmonyos' },
  });
});

test('HarmonyOS logs run the PID lookup and the stream on the setup host, not the runtime host', async () => {
  const root = createHarmonyToolchainRoot();
  const fixture = hostFixture({ env: { HDC_SDK_PATH: root, PATH: '/usr/bin' } });
  const binding = await createHarmonyAppLogRuntime(fixture.host, fixture.toolbox).bind({
    device,
    intent: { kind: 'ordinary' },
    scope,
  });

  const started = await binding.operations.appLogStart?.(startInput);

  // Both commands name the HDC the configured root carries, and both were handed a PATH that root
  // leads. The core's own local process transport never starts this family's stream: it builds its
  // spawn environment without the family's roots.
  const [pidLookup] = fixture.hdcCommands();
  expect(pidLookup).toEqual(['-t', 'harmony-1', 'shell', 'pidof', 'com.example.harmony']);
  expect(fixture.commandPaths()).toEqual([[root, '/usr/bin']]);
  expect(fixture.streams).toHaveLength(1);
  expect(fixture.streams[0]!.executable).toBe(path.join(root, 'hdc'));
  expect(harmonyCommandPath(fixture.streams[0]!)).toEqual([root, '/usr/bin']);
  expect(fixture.streams[0]!.markerPath).toBe('/tmp/app-log.pid');
  expect(fixture.runtimeHostStarts()).toBe(0);
  expect(fixture.runtimeHostCommands()).toEqual([]);
  await started?.pendingHandle.transfer().finish();
});

test('HarmonyOS log stream answers the runtime host transport it did not use', async () => {
  // Availability still comes from the selected transport: the plan replaces only its route.
  const fixture = hostFixture();
  const binding = await createHarmonyAppLogRuntime(fixture.host, fixture.toolbox).bind({
    device,
    intent: { kind: 'ordinary' },
    scope,
  });

  expect(binding.facts.operations.appLogStart).toEqual({ available: true });
  const started = await binding.operations.appLogStart?.(startInput);
  await started?.pendingHandle.transfer().finish();
  expect(fixture.runtimeHostStarts()).toBe(0);
});

test('rejects a missing HDC tool before opening output or starting a process', async () => {
  const fixture = hostFixture({
    reject: (executable) =>
      new AppError('TOOL_MISSING', MISSING_HDC, { cmd: executable }, undefined),
  });
  const binding = await createHarmonyAppLogRuntime(fixture.host, fixture.toolbox).bind({
    device,
    intent: { kind: 'ordinary' },
    scope,
  });

  await expect(binding.operations.appLogStart?.(startInput)).rejects.toMatchObject({
    code: 'TOOL_MISSING',
    message: MISSING_HDC,
    details: {
      hint: MISSING_HDC_HINT,
    },
  });
  expect(fixture.outputOpens()).toBe(0);
  expect(fixture.streams).toEqual([]);
});

test('rejects cross-session start and recovery paths before host authority is used', async () => {
  const fixture = hostFixture();
  const runtimeOwner = createHarmonyAppLogRuntime(fixture.host, fixture.toolbox);
  const binding = await runtimeOwner.bind({ device, intent: { kind: 'ordinary' }, scope });
  const envelope = createHarmonyAppLogEnvelope({
    sessionId: 'session',
    device,
    owner: runtimeOwner.owner,
    fence: { token: 'fence', generation: 1 },
    descriptor: {
      transport: 'harmony-hilog',
      outputPath: '/tmp/app.log',
      pidPath: '/tmp/other/app-log.pid',
    },
  });

  await expect(binding.operations.appLogReattach?.({ envelope })).resolves.toMatchObject({
    status: 'unreattachable',
    reason: 'descriptor-invalid',
  });
  await expect(binding.operations.appLogCleanup?.({ envelope })).resolves.toMatchObject({
    status: 'cleanup-pending',
    reason: 'ownership-fence-lost',
  });
  await expect(
    binding.operations.appLogStart?.({
      sessionId: 'session',
      appBundleId: 'com.example.harmony',
      outputPath: '/tmp/other/app.log',
      fence: { token: 'fence', generation: 1 },
    }),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  expect(fixture.markerReads()).toBe(0);
  expect(fixture.outputOpens()).toBe(0);
  expect(fixture.hostCommands).toEqual([]);
});

test('HarmonyOS log preflight answers an already-aborted request before any HDC command', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled');
  controller.abort(reason);
  const fixture = hostFixture();
  const binding = await createHarmonyAppLogRuntime(fixture.host, fixture.toolbox).bind({
    device,
    intent: { kind: 'ordinary' },
    scope: { ...scope, signal: controller.signal },
  });

  await expect(
    binding.operations.appLogStart?.({
      sessionId: 'session',
      appBundleId: 'com.example.harmony',
      outputPath: '/tmp/app.log',
      fence: { token: 'fence', generation: 1 },
    }),
  ).rejects.toBe(reason);
  expect(fixture.outputOpens()).toBe(0);
  expect(fixture.hostCommands).toEqual([]);
  expect(fixture.streams).toEqual([]);
});

test('HarmonyOS log commands carry the request signal so the host aborts them', async () => {
  // The host owns the abort: the running `pidof` is asked with the request's own signal, and the
  // stream is asked with a signal the request cancels while the start is still in flight, so a
  // cancelled request cancels both rather than leaking a spawned `hilog`.
  const controller = new AbortController();
  let streamSignal: AbortSignal | undefined;
  const held = deferred();
  const fixture = hostFixture({
    holdStreamStart: async (signal) => {
      streamSignal = signal;
      await held.promise;
    },
  });
  const binding = await createHarmonyAppLogRuntime(fixture.host, fixture.toolbox).bind({
    device,
    intent: { kind: 'ordinary' },
    scope: { ...scope, signal: controller.signal },
  });

  const started = binding.operations.appLogStart?.(startInput);
  await fixture.streamStarted();
  expect(fixture.hdcCommands()).toHaveLength(1);
  expect(fixture.pidLookupSignal()).toBe(controller.signal);
  expect(streamSignal?.aborted).toBe(false);

  controller.abort(new Error('cancelled'));
  expect(streamSignal?.aborted).toBe(true);
  held.resolve();
  await expect(started).rejects.toThrow('cancelled');
});

function deferred(): Readonly<{ promise: Promise<void>; resolve(): void }> {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function hostFixture(
  options: Readonly<{
    /** The environment the plugin's own setup host names, including its toolchain roots. */
    env?: Readonly<Record<string, string | undefined>>;
    /** Rejected one command, the way the host rejects a spawn it cannot start. */
    reject?: (executable: string, args: readonly string[]) => Error;
    /** Held the managed stream start open. */
    holdStreamStart?: (signal: AbortSignal | undefined) => Promise<void>;
  }> = {},
) {
  // Every command the plugin asked its setup host to run: the one-shot PID lookup and the streamed
  // hilog, each with the environment the plugin built for it. The device answers its app lookup with
  // one PID, which is what lets the stream begin.
  let streamRequested: () => void = () => {};
  const streamRequestedOnce = new Promise<void>((resolve) => {
    streamRequested = resolve;
  });
  const stub = createHarmonyHostStub({
    env: options.env,
    reject: options.reject,
    respond: (_executable, args) => (args.includes('pidof') ? { stdout: '456\n' } : {}),
    ...(options.holdStreamStart === undefined
      ? {}
      : {
          holdStreamStart: async (signal) => {
            streamRequested();
            await options.holdStreamStart!(signal);
          },
        }),
  });
  let runtimeHostStartCount = 0;
  const runtimeHostCommands: string[][] = [];
  let outputOpens = 0;
  let markerReads = 0;
  const unusedStart: AppLogRuntimeHost['processes']['start'] = async ({ command }) => {
    runtimeHostStartCount += 1;
    if (command.kind === 'host') {
      runtimeHostCommands.push([command.request.executable, ...command.request.args]);
    }
    throw new Error('The HarmonyOS app-log plan owns its process route');
  };
  const host: AppLogRuntimeHost = {
    appleTools: {
      isXcrunAvailable: async () => false,
      run: async () => {
        throw new Error('unused');
      },
    },
    toolchains: { prepare: async () => undefined },
    artifacts: {
      resolveSession: () => ({ outputPath: '/tmp/app.log', pidPath: '/tmp/app-log.pid' }),
    },
    commands: {
      which: async () => {
        throw new Error('The HarmonyOS plugin resolves HDC on its own host');
      },
      run: async (request) => {
        runtimeHostCommands.push([request.executable, ...request.args]);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    },
    outputs: {
      readTail: async () => '',
      openAppend: async () => {
        outputOpens += 1;
        return { write: async () => {}, [Symbol.asyncDispose]: async () => {} };
      },
    },
    processTransports: {
      // The core's local transport: present, which is what makes `logs start` available, and never
      // used to start this family's stream.
      resolve: async () => ({ mode: 'local', start: unusedStart }),
    },
    processes: {
      start: unusedStart,
      readMarker: async () => {
        markerReads += 1;
        return { status: 'missing' };
      },
      clearMarker: async () => {},
      inspect: async () => 'missing',
      terminate: async () => 'already-missing',
    },
    clock: { now: () => 10, sleep: waitForMonitorWake },
  };
  return {
    host,
    toolbox: stub.toolbox,
    hostCommands: stub.commands,
    streams: stub.streams,
    /** The HDC argv of every one-shot command, with the family's own launcher dropped. */
    hdcCommands: () => stub.commands.map(({ args }) => [...args]),
    /** The `PATH` entries the plugin handed each one-shot command, in order. */
    commandPaths: () => stub.commands.map((command) => harmonyCommandPath(command)),
    pidLookupSignal: () => stub.commands[0]?.signal,
    /** Settles once the plugin has asked the host to keep its stream running. */
    streamStarted: () => streamRequestedOnce,
    runtimeHostStarts: () => runtimeHostStartCount,
    runtimeHostCommands: () => runtimeHostCommands,
    markerReads: () => markerReads,
    outputOpens: () => outputOpens,
  };
}

/**
 * The monitor polls while it waits, so its sleep stays pending until disposal stops it. Without an
 * abort it would resolve on nothing and spin.
 */
async function waitForMonitorWake(_milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    signal?.addEventListener('abort', () => resolve(), { once: true });
  });
}
