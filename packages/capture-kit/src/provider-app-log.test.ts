import { APP_LOG_RESOURCE_KIND } from '@agent-device/contracts/app-log-runtime';
import type { DurableDescriptorCodec } from '@agent-device/contracts/durable-resource-envelope';
import { providerRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { expect, test, vi } from 'vitest';
import {
  createProviderAppLogEnvelope,
  createProviderAppLogOperations,
  type ProviderAppLogOptions,
  type ProviderAppLogReader,
} from './provider-app-log.ts';

type ExampleDescriptor = Readonly<{
  transport: 'example-log-poller';
  instanceId: string;
  appBundleId: string;
  outputPath: string;
}>;

type ExampleReader = ProviderAppLogReader & Readonly<{ instanceId: string }>;

const device: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'example:ios:lease-a',
  name: 'Example iOS',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

const owner = providerRuntimeOwner('example', 'default');
const fence = { token: 'fence', generation: 1 };

const codec: DurableDescriptorCodec<ExampleDescriptor, typeof APP_LOG_RESOURCE_KIND> = {
  resourceKind: APP_LOG_RESOURCE_KIND,
  version: 1,
  encode: (descriptor) => ({ ...descriptor }),
  decode: (body) =>
    body.transport === 'example-log-poller' &&
    typeof body.instanceId === 'string' &&
    typeof body.appBundleId === 'string' &&
    typeof body.outputPath === 'string'
      ? {
          status: 'decoded',
          descriptor: {
            transport: 'example-log-poller',
            instanceId: body.instanceId,
            appBundleId: body.appBundleId,
            outputPath: body.outputPath,
          },
        }
      : { status: 'invalid', message: 'Invalid example app-log descriptor' },
};

test('starts a poller over the current reader and persists the provider descriptor', async () => {
  const reader = exampleReader();
  const operations = createProviderAppLogOperations(
    exampleOptions({ openCurrent: async () => reader }),
  );

  const started = await operations.appLogStart({
    sessionId: 'one',
    appBundleId: 'com.example.app',
    outputPath: '/sessions/one/app.log',
    fence,
  });

  expect(started.envelope).toMatchObject({
    resourceKind: 'app-log',
    sessionId: 'one',
    device: { id: device.id, family: 'apple', appleOs: 'ios', kind: 'simulator' },
    owner,
    fence,
    descriptor: {
      body: {
        transport: 'example-log-poller',
        instanceId: 'instance-a',
        appBundleId: 'com.example.app',
        outputPath: '/sessions/one/app.log',
      },
    },
  });
  const handle = started.pendingHandle.transfer();
  await expect(handle.finish()).resolves.toMatchObject({
    status: 'completed',
    result: { backend: 'ios-simulator', outputPath: '/sessions/one/app.log' },
  });
  expect(reader[Symbol.asyncDispose]).toHaveBeenCalledOnce();
});

test('refuses to start without a current reader using the provider message', async () => {
  const operations = createProviderAppLogOperations(exampleOptions());

  await expect(
    operations.appLogStart({
      sessionId: 'one',
      appBundleId: 'com.example.app',
      outputPath: '/sessions/one/app.log',
      fence,
    }),
  ).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    message: 'Example app logs require an active instance',
  });
});

test('disposes the current reader when the request aborts before the poller adopts it', async () => {
  const controller = new AbortController();
  const reader = exampleReader();
  const operations = createProviderAppLogOperations(
    exampleOptions({
      signal: controller.signal,
      openCurrent: async () => {
        controller.abort(new Error('caller left'));
        return reader;
      },
    }),
  );

  await expect(
    operations.appLogStart({
      sessionId: 'one',
      appBundleId: 'com.example.app',
      outputPath: '/sessions/one/app.log',
      fence,
    }),
  ).rejects.toThrow('caller left');
  expect(reader[Symbol.asyncDispose]).toHaveBeenCalledOnce();
});

test('refuses a descriptor for another device before reconnecting', async () => {
  const reconnect = vi.fn(async () => ({ status: 'missing' as const }));
  const operations = createProviderAppLogOperations(
    exampleOptions({ matchesDevice: () => false, reconnect }),
  );
  const envelope = exampleEnvelope('/sessions/one/app.log');
  const message = 'Example app-log descriptor does not match the bound device or owning session';

  await expect(operations.appLogReattach({ envelope })).resolves.toEqual({
    status: 'unreattachable',
    reason: 'descriptor-invalid',
    message,
  });
  await expect(operations.appLogCleanup({ envelope })).resolves.toEqual({
    status: 'cleanup-pending',
    reason: 'ownership-fence-lost',
    message,
  });
  expect(reconnect).not.toHaveBeenCalled();
});

test.each([
  ['missing', { status: 'missing' }],
  ['ownership-lost', { status: 'unreattachable', reason: 'ownership-fence-lost' }],
] as const)('maps a %s reconnect onto the reattach outcome', async (status, expected) => {
  const operations = createProviderAppLogOperations(
    exampleOptions({ reconnect: async () => ({ status }) }),
  );

  await expect(
    operations.appLogReattach({ envelope: exampleEnvelope('/sessions/one/app.log') }),
  ).resolves.toEqual(expected);
});

test('reattaches a poller over the reconnected reader', async () => {
  const reader = exampleReader();
  const reconnect = vi.fn(async () => ({ status: 'opened' as const, reader }));
  const operations = createProviderAppLogOperations(exampleOptions({ reconnect }));

  const outcome = await operations.appLogReattach({
    envelope: exampleEnvelope('/sessions/one/app.log'),
  });

  expect(reconnect).toHaveBeenCalledWith(
    expect.objectContaining({ instanceId: 'instance-a' }),
    expect.any(AbortSignal),
  );
  if (outcome.status !== 'active') throw new Error(`unexpected ${outcome.status}`);
  await outcome.handle.finish();
  expect(reader[Symbol.asyncDispose]).toHaveBeenCalledOnce();
});

test('reports whether a current reader opens under the provider check key', async () => {
  const reader = exampleReader();
  const available = createProviderAppLogOperations(
    exampleOptions({ openCurrent: async () => reader }),
  );
  const unavailable = createProviderAppLogOperations(exampleOptions());

  await expect(available.appLogDoctor({})).resolves.toEqual({
    backend: 'ios-simulator',
    checks: { exampleSessionAvailable: true },
    notes: [],
  });
  await expect(unavailable.appLogDoctor({})).resolves.toMatchObject({
    checks: { exampleSessionAvailable: false },
  });
  expect(reader[Symbol.asyncDispose]).toHaveBeenCalledOnce();
});

test('refuses to persist an Apple device without its appleOs identity', () => {
  expect(() =>
    createProviderAppLogEnvelope({
      provider: 'Example',
      codec,
      sessionId: 'one',
      device: { ...device, appleOs: undefined },
      owner,
      fence,
      descriptor: exampleDescriptor('/sessions/one/app.log'),
    }),
  ).toThrow('Example Apple app-log persistence requires an explicit appleOs identity');
});

function exampleOptions(
  overrides: Partial<ProviderAppLogOptions<ExampleDescriptor, ExampleReader>> = {},
): ProviderAppLogOptions<ExampleDescriptor, ExampleReader> {
  return {
    host: exampleHost(),
    device,
    owner,
    signal: new AbortController().signal,
    provider: 'Example',
    backend: 'ios-simulator',
    sessionCheck: 'exampleSessionAvailable',
    unavailableMessage: 'Example app logs require an active instance',
    codec,
    openCurrent: async () => undefined,
    describe: (reader, target) => ({
      transport: 'example-log-poller',
      instanceId: reader.instanceId,
      appBundleId: target.appBundleId,
      outputPath: target.outputPath,
    }),
    matchesDevice: () => true,
    reconnect: async () => ({ status: 'missing' }),
    ...overrides,
  };
}

function exampleReader() {
  return {
    instanceId: 'instance-a',
    readLogs: vi.fn(async () => ''),
    [Symbol.asyncDispose]: vi.fn(async () => {}),
  } satisfies ExampleReader;
}

function exampleDescriptor(outputPath: string): ExampleDescriptor {
  return {
    transport: 'example-log-poller',
    instanceId: 'instance-a',
    appBundleId: 'com.example.app',
    outputPath,
  };
}

function exampleEnvelope(outputPath: string) {
  return createProviderAppLogEnvelope({
    provider: 'Example',
    codec,
    sessionId: 'one',
    device,
    owner,
    fence,
    descriptor: exampleDescriptor(outputPath),
  });
}

function exampleHost(): ProviderAppLogOptions<ExampleDescriptor, ExampleReader>['host'] {
  return {
    artifacts: {
      resolveSession: (sessionId: string) => ({
        outputPath: `/sessions/${sessionId}/app.log`,
        pidPath: `/sessions/${sessionId}/app-log.pid`,
      }),
    },
    outputs: {
      readTail: async () => '',
      openAppend: async () => ({ write: async () => {}, [Symbol.asyncDispose]: async () => {} }),
    },
    clock: {
      now: () => 100,
      sleep: async () => await new Promise<void>((resolve) => setTimeout(resolve, 0)),
    },
    appLogs: {
      readRecent: async () => ({
        path: '/sessions/one/app.log',
        exists: false,
        text: '',
        skippedLines: 0,
      }),
      readProcessMarker: async () => ({ status: 'missing' }),
    },
  };
}
