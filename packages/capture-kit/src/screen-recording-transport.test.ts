import { expect, test, vi } from 'vitest';
import type { ScreenRecordingStartInput } from '@agent-device/contracts/screen-recording-runtime';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import {
  startTransportScreenRecording,
  transportRecordingDescriptorCodec,
  type ScreenRecordingTransport,
} from './screen-recording-transport.ts';

const device = {
  platform: 'apple' as const,
  appleOs: 'ios' as const,
  id: 'provider:ios:lease-a',
  name: 'Provider iOS',
  kind: 'simulator' as const,
  target: 'mobile' as const,
  booted: true,
};

function input(overrides: Partial<ScreenRecordingStartInput> = {}): ScreenRecordingStartInput {
  return {
    sessionId: 'one',
    outputPath: '/tmp/capture.mp4',
    scope: 'app',
    showTouches: false,
    hideTouchesRequested: false,
    recordOnlySession: false,
    fence: { token: 'fence', generation: 1 },
    ...overrides,
  };
}

function harness(
  options: {
    transport?: Partial<ScreenRecordingTransport<string>>;
    finalize?: () => Promise<Record<string, never>>;
    signal?: AbortSignal;
  } = {},
) {
  const calls: string[] = [];
  const transport: ScreenRecordingTransport<string> = {
    backend: 'test-recorder',
    targetLabel: 'test recording',
    start: async () => {
      calls.push('start');
    },
    stop: async () => {
      calls.push('stop');
      return 'https://recorder.example/clip.mp4';
    },
    collect: async (url, outputPath) => {
      calls.push(`collect:${url}->${outputPath}`);
    },
    ...options.transport,
  };
  const prepare = vi.fn(async () => {
    calls.push('prepare');
  });
  const complete = vi.fn(async () => {
    calls.push('finalize');
    return await (options.finalize ?? (async () => ({})))();
  });
  const start = () =>
    startTransportScreenRecording({
      host: {
        screenRecording: {
          outputs: { prepare, copy: async () => {}, remove: async () => 'removed' as const },
          finalize: { sniff: async () => {}, complete },
        },
      },
      device,
      owner: localRuntimeOwner('apple'),
      input: input(),
      signal: options.signal ?? new AbortController().signal,
      transport,
      support: { scopes: ['app'], fps: false, exportQuality: true, hideTouches: false },
      unsupported: (unsupported) => `test recordings do not support ${unsupported.join(', ')}`,
    });
  return { start, calls, prepare, complete, transport };
}

test('a finish stops once, collects to the output path, finalizes, and confirms the recorder', async () => {
  const { start, calls } = harness();
  const started = await start();

  const outcome = await started.pendingHandle.transfer().finish();

  expect(calls).toEqual([
    'prepare',
    'start',
    'stop',
    'collect:https://recorder.example/clip.mp4->/tmp/capture.mp4',
    'finalize',
  ]);
  expect(outcome).toMatchObject({
    status: 'completed',
    result: {
      backend: 'test-recorder',
      outPath: '/tmp/capture.mp4',
      stopObservation: { recorder: 'confirmed' },
    },
  });
});

test('a collect that fails after a successful stop is retried by the next finish without a second stop', async () => {
  let collects = 0;
  const { start, calls } = harness({
    transport: {
      collect: async () => {
        collects += 1;
        if (collects === 1) throw new Error('download dropped');
      },
    },
  });
  const handle = (await start()).pendingHandle.transfer();

  await expect(handle.finish()).rejects.toThrow('download dropped');
  await expect(handle.finish()).resolves.toMatchObject({ status: 'completed' });

  expect(calls.filter((call) => call === 'stop')).toHaveLength(1);
  expect(collects).toBe(2);
});

test('a stop that fails is retried by the next finish', async () => {
  let stops = 0;
  const { start } = harness({
    transport: {
      stop: async () => {
        stops += 1;
        if (stops === 1) throw new Error('instance busy');
        return 'https://recorder.example/clip.mp4';
      },
    },
  });
  const handle = (await start()).pendingHandle.transfer();

  await expect(handle.finish()).rejects.toThrow('instance busy');
  await expect(handle.finish()).resolves.toMatchObject({ status: 'completed' });
  expect(stops).toBe(2);
});

test('cleanup after a failed finish stops the recorder once and does not collect again', async () => {
  const { start, calls } = harness({
    finalize: async () => {
      throw new Error('export unplayable');
    },
    transport: {
      collect: async () => {
        calls.push('collect');
      },
    },
  });
  const handle = (await start()).pendingHandle.transfer();

  await expect(handle.finish()).rejects.toThrow('export unplayable');
  await expect(handle.forceCleanup()).resolves.toEqual({ status: 'cleaned' });

  expect(calls.filter((call) => call === 'stop')).toHaveLength(1);
  expect(calls.filter((call) => call.startsWith('collect'))).toHaveLength(1);
});

test('unsupported options are refused with a typed error before the output is prepared', async () => {
  const { prepare, calls } = harness();
  const started = startTransportScreenRecording({
    host: {
      screenRecording: {
        outputs: { prepare, copy: async () => {}, remove: async () => 'removed' as const },
        finalize: { sniff: async () => {}, complete: async () => ({}) },
      },
    },
    device,
    owner: localRuntimeOwner('apple'),
    input: input({ fps: 30 }),
    signal: new AbortController().signal,
    transport: {
      backend: 'test-recorder',
      targetLabel: 'test recording',
      start: async () => {
        calls.push('start');
      },
      stop: async () => {},
    },
    support: { scopes: ['app'], fps: false, exportQuality: false, hideTouches: false },
    unsupported: (unsupported) => `test recordings do not support ${unsupported.join(', ')}`,
  });

  await expect(started).rejects.toMatchObject({
    code: 'INVALID_ARGS',
    message: 'test recordings do not support --fps',
  });
  expect(prepare).not.toHaveBeenCalled();
  expect(calls).toEqual([]);
});

test('a start cancelled after the recorder acquired is stopped again and reports the cancellation', async () => {
  const controller = new AbortController();
  const reason = new Error('request cancelled');
  const { start, calls } = harness({
    signal: controller.signal,
    transport: {
      start: async () => {
        calls.push('start');
        controller.abort(reason);
      },
    },
  });

  await expect(start()).rejects.toBe(reason);
  expect(calls).toEqual(['prepare', 'start', 'stop']);
});

test('the durable descriptor round-trips through the backend-scoped codec', async () => {
  const { start } = harness();
  const { envelope } = await start();
  const codec = transportRecordingDescriptorCodec('test-recorder');

  expect(codec.decode(envelope.descriptor.body)).toEqual({
    status: 'decoded',
    descriptor: { backend: 'test-recorder', outputPath: '/tmp/capture.mp4' },
  });
  expect(codec.decode({ backend: 'other-recorder', outputPath: '/tmp/capture.mp4' })).toMatchObject(
    {
      status: 'invalid',
    },
  );
});
