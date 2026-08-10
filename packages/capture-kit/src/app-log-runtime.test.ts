import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  localRuntimeOwner,
  providerRuntimeOwner,
  type AppLogCompletion,
  type AppLogBackgroundProcessRequest,
  type AppLogProcessOwnership,
  type AppLogProcessTransport,
  type AppLogRuntimeHost,
  type AppLogRuntimeProviderModule,
  type DurableDescriptorCodec,
} from '@agent-device/contracts/platform';
import { APP_LOG_ENVELOPE_FIXTURE } from './durable-resource-envelope.fixtures.ts';
import { createAppLogLiveHandle } from './app-log-live-handle.ts';
import {
  createAppLogRecoveryOperations,
  createAppLogStartResult,
  decodeAppLogProcessMarker,
} from './app-log-runtime.ts';

const completion: AppLogCompletion = {
  backend: 'android',
  outputPath: '/tmp/app.log',
  completedAt: 42,
};

function compileTimeProviderModuleProof(): void {
  const invalid: AppLogRuntimeProviderModule = {
    // @ts-expect-error Provider modules cannot advertise a local-family owner.
    owner: localRuntimeOwner('apple'),
    loadRuntime: async () => {
      throw new Error('not loaded');
    },
  };
  void invalid;
}
void compileTimeProviderModuleProof;

function compileTimeProcessTransportProof(): void {
  const invalid: AppLogProcessTransport = {
    // @ts-expect-error A direct provider runtime is an owner, not a narrow process transport.
    mode: 'provider-runtime',
  };
  void invalid;
}
void compileTimeProcessTransportProof;

function compileTimeBackgroundCommandProof(): void {
  const invalid: AppLogBackgroundProcessRequest = {
    // @ts-expect-error Background commands require an explicit host/provider transport descriptor.
    command: { executable: 'adb', args: ['-s', 'serial-1', 'logcat'] },
    output: {
      write: async () => {},
      [Symbol.asyncDispose]: async () => {},
    },
  };
  void invalid;
}
void compileTimeBackgroundCommandProof;

test('app-log live handle makes finish and forced async disposal idempotent', async () => {
  const finish = vi.fn(async () => ({ status: 'completed', result: completion }) as const);
  const cleanup = vi.fn(async () => ({ status: 'cleaned' }) as const);
  const handle = createAppLogLiveHandle({
    inspect: () => ({ backend: 'android', state: 'active', startedAt: 12 }),
    finish,
    forceCleanup: cleanup,
  });

  assert.deepEqual(handle.inspect(), { backend: 'android', state: 'active', startedAt: 12 });
  assert.deepEqual(await handle.finish(), { status: 'completed', result: completion });
  assert.deepEqual(await handle.finish(), { status: 'completed', result: completion });
  await handle[Symbol.asyncDispose]();
  await handle[Symbol.asyncDispose]();

  assert.equal(finish.mock.calls.length, 1);
  assert.equal(cleanup.mock.calls.length, 1);
});

test('app-log async disposal rejects when forced cleanup remains unconfirmed', async () => {
  const handle = createAppLogLiveHandle({
    inspect: () => ({ backend: 'android', state: 'failed', startedAt: 12 }),
    finish: async () => ({ status: 'completed', result: completion }),
    forceCleanup: async () => ({
      status: 'cleanup-pending',
      reason: 'ownership-fence-lost',
    }),
  });

  await assert.rejects(
    async () => await handle[Symbol.asyncDispose](),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'ownership-fence-lost',
  );
});

test('app-log start result retains pending ownership until explicit transfer', async () => {
  let cleanupCount = 0;
  const handle = createAppLogLiveHandle({
    inspect: () => ({ backend: 'android', state: 'active', startedAt: 12 }),
    finish: async () => ({ status: 'completed', result: completion }),
    forceCleanup: async () => {
      cleanupCount += 1;
      return { status: 'cleaned' };
    },
  });
  const result = createAppLogStartResult(handle, APP_LOG_ENVELOPE_FIXTURE);

  await result.pendingHandle[Symbol.asyncDispose]();
  assert.equal(cleanupCount, 1);

  const adopted = createAppLogStartResult(handle, APP_LOG_ENVELOPE_FIXTURE);
  assert.equal(adopted.pendingHandle.transfer(), handle);
  await adopted.pendingHandle[Symbol.asyncDispose]();
  assert.equal(cleanupCount, 1);
});

test('app-log recovery decodes only after exact-owner selection and fails closed', async () => {
  type Descriptor = Readonly<{ pid: number }>;
  const codec: DurableDescriptorCodec<Descriptor, 'app-log'> = {
    resourceKind: 'app-log',
    version: 2,
    encode: ({ pid }) => ({ pid }),
    decode: (body) =>
      typeof body.pid === 'number'
        ? { status: 'decoded', descriptor: { pid: body.pid } }
        : { status: 'invalid', message: 'pid is invalid' },
  };
  let reattachedDescriptor: Descriptor | undefined;
  const reattach = vi.fn(async (descriptor: Descriptor, _context: unknown) => {
    reattachedDescriptor = descriptor;
    return { status: 'missing' } as const;
  });
  const cleanup = vi.fn(
    async (_descriptor: Descriptor) => ({ status: 'already-missing' }) as const,
  );
  const operations = createAppLogRecoveryOperations({ codec, reattach, cleanup });

  assert.deepEqual(await operations.appLogReattach({ envelope: APP_LOG_ENVELOPE_FIXTURE }), {
    status: 'missing',
  });
  assert.equal(reattachedDescriptor?.pid, 42);
  assert.deepEqual(reattach.mock.calls[0]?.[1], {
    sessionId: APP_LOG_ENVELOPE_FIXTURE.sessionId,
    fence: APP_LOG_ENVELOPE_FIXTURE.fence,
  });

  const unsupported = {
    ...APP_LOG_ENVELOPE_FIXTURE,
    descriptor: { ...APP_LOG_ENVELOPE_FIXTURE.descriptor, version: 9 },
  };
  assert.deepEqual(await operations.appLogReattach({ envelope: unsupported }), {
    status: 'unreattachable',
    reason: 'descriptor-version-unsupported',
    message: 'Unsupported app-log descriptor version: 9',
    version: 9,
  });
  assert.deepEqual(await operations.appLogCleanup({ envelope: unsupported }), {
    status: 'cleanup-pending',
    reason: 'manual-recovery-required',
    message: 'Unsupported app-log descriptor version: 9',
  });
  assert.equal(cleanup.mock.calls.length, 0);
});

test('app-log process marker decoding keeps incomplete or corrupt state distinct from missing', () => {
  assert.deepEqual(decodeAppLogProcessMarker(undefined), {
    status: 'invalid',
    message: 'App-log process marker must be an object',
  });
  assert.deepEqual(decodeAppLogProcessMarker({ pid: 42, command: 'adb logcat' }), {
    status: 'invalid',
    message: 'App-log process marker startTime must be a non-empty string',
  });
  assert.deepEqual(
    decodeAppLogProcessMarker({ pid: 42, startTime: '12345', command: 'adb logcat' }),
    {
      status: 'decoded',
      marker: { pid: 42, startTime: '12345', command: 'adb logcat' },
    },
  );
});

test('app-log ownership probe cannot collapse a mismatched live process into missing', () => {
  const recoveryDecision = (
    ownership: AppLogProcessOwnership,
  ): 'complete' | 'reattach' | 'retain' => {
    switch (ownership) {
      case 'missing':
        return 'complete';
      case 'owned-alive':
        return 'reattach';
      case 'ownership-lost':
        return 'retain';
    }
  };

  assert.equal(recoveryDecision('missing'), 'complete');
  assert.equal(recoveryDecision('owned-alive'), 'reattach');
  assert.equal(recoveryDecision('ownership-lost'), 'retain');
});

test('app-log output host exposes only a bounded session-confined tail read', () => {
  type ReadTail = AppLogRuntimeHost['outputs']['readTail'];
  const readTail: ReadTail = async (_path, _maxBytes) => 'existing suffix';

  assert.equal(readTail.length, 2);
});

test('app-log process transport keeps narrow provider composition separate from runtime ownership', () => {
  const transport = {
    mode: 'transport-composed',
  } satisfies AppLogProcessTransport;

  assert.equal(transport.mode, 'transport-composed');
  assert.equal('start' in transport, false);
});

test('app-log artifact authority resolves canonical paths from durable session identity', () => {
  type ResolveSession = AppLogRuntimeHost['artifacts']['resolveSession'];
  const resolveSession: ResolveSession = (sessionId) => ({
    outputPath: `/sessions/${sessionId}/app.log`,
    pidPath: `/sessions/${sessionId}/app-log.pid`,
  });

  assert.deepEqual(resolveSession('session-a'), {
    outputPath: '/sessions/session-a/app.log',
    pidPath: '/sessions/session-a/app-log.pid',
  });
});

test('app-log provider module exposes inert exact-owner metadata without loading mechanics', () => {
  const loadRuntime = vi.fn(async () => {
    throw new Error('not loaded');
  });
  const module: AppLogRuntimeProviderModule = {
    owner: providerRuntimeOwner('limrun', 'tenant-a'),
    loadRuntime,
  };

  assert.deepEqual(module.owner, {
    kind: 'provider-runtime',
    provider: 'limrun',
    instance: 'tenant-a',
  });
  assert.equal(loadRuntime.mock.calls.length, 0);
});
