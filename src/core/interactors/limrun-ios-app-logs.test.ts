import { EventEmitter } from 'node:events';
import { expect, test, vi } from 'vitest';
import type { InstanceClient, LogStream } from '@limrun/api/ios-client';
import { fixture } from './limrun-ios-runner.fixtures.ts';
import { createLimrunRuntimeDependencies } from '../../sdk/limrun-runtime-dependencies.ts';

const plist = Buffer.from(
  '<plist><dict><key>CFBundleExecutable</key><string>Example</string></dict></plist>',
);
const record = (process: string, subsystem: string, text: string) =>
  `2026-11-02 12:00:00.000001 Info ${process}[42:0x123] (${subsystem}) [test] ${text}`;
async function logFixture(options: { holdFileDownload?: boolean; failFileStatus?: number } = {}) {
  const f = await fixture({
    containers: { 'com.example.app': { app: { 'Info.plist': plist } } },
    ...options,
    ...(options.failFileStatus ? { failFileMethod: 'GET' } : {}),
  });
  const streams: LogStream[] = [];
  const stream = () => {
    const emitter = new EventEmitter();
    const value = Object.assign(emitter, {
      stop: vi.fn(() => emitter.emit('close')),
    }) as unknown as LogStream;
    streams.push(value);
    return value;
  };
  const client = {
    streamAppLog: stream,
    streamSyslog: stream,
    appLogTail: vi.fn(async () => ''),
  } as unknown as InstanceClient;
  const dependencies = createLimrunRuntimeDependencies({ env: {}, cwd: f.directory });
  const reader = dependencies.ios.createAppLogReader({ ...f.session, client });
  const read = () => reader.readLogs('com.example.app', 100, new AbortController().signal);
  return { reader, read, streams, storage: f.storage, client };
}

test('app logs retain repeated console lines and matching syslog without matching message text', async () => {
  const f = await logFixture();
  try {
    await f.read();
    f.streams[0]!.emit('line', 'same stdout');
    f.streams[0]!.emit('line', 'same stdout');
    const processLine = record('Example', 'framework', 'process output');
    const subsystemLine = record('other', 'com.example.app.service', 'subsystem output');
    f.streams[1]!.emit('line', processLine);
    f.streams[1]!.emit('line', subsystemLine);
    f.streams[1]!.emit('line', record('other', 'unrelated', 'Example com.example.app'));
    f.streams[1]!.emit('line', record('other', 'com.example.application', 'wrong prefix'));
    f.streams[1]!.emit('line', record('other', 'org.com.example.app', 'wrong namespace'));
    await vi.waitFor(async () =>
      expect(await f.read()).toBe(
        ['same stdout', 'same stdout', processLine, subsystemLine].join('\n'),
      ),
    );
  } finally {
    await f.reader[Symbol.asyncDispose]();
  }
  expect(f.streams.every((stream) => vi.mocked(stream.stop).mock.calls.length === 1)).toBe(true);
});

test('broken streams report failure, close both sockets and reopen on the following poll', async () => {
  const f = await logFixture();
  try {
    await f.read();
    const error = new Error('transport lost');
    f.streams[1]!.emit('error', error);
    await expect(f.read()).rejects.toBe(error);
    expect(f.streams.every((stream) => vi.mocked(stream.stop).mock.calls.length === 1)).toBe(true);
    await f.read();
    expect(f.streams).toHaveLength(4);
    f.streams[2]!.emit('line', 'reconnected');
    expect(await f.read()).toBe('reconnected');
  } finally {
    await f.reader[Symbol.asyncDispose]();
  }
});

test('the log tail bounds retained bytes and disposal refuses further reads', async () => {
  const f = await logFixture();
  await f.read();
  f.streams[0]!.emit('line', 'a'.repeat(1024 * 1024));
  f.streams[0]!.emit('line', 'tail');
  expect(await f.read()).toBe('tail');
  await f.reader[Symbol.asyncDispose]();
  await expect(f.read()).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.streams.every((stream) => vi.mocked(stream.stop).mock.calls.length === 1)).toBe(true);
});

test('slow app metadata does not delay polls and survives completion of an individual poll', async () => {
  const f = await logFixture({ holdFileDownload: true });
  const poll = new AbortController();
  let completed = false;
  const firstRead = f.reader.readLogs('com.example.app', 100, poll.signal).then(() => {
    completed = true;
  });
  try {
    await vi.waitFor(() =>
      expect(completed, 'the poll must finish while the metadata response is held').toBe(true),
    );
    await firstRead;
    poll.abort();
    f.streams[0]!.emit('line', 'console while metadata loads');
    const systemLine = record('Example', 'framework', 'buffered process output');
    f.streams[1]!.emit('line', systemLine);
    expect(await f.read()).toBe('console while metadata loads');
    await vi.waitFor(() =>
      expect(f.storage.calls.some((call) => call.method === 'GET')).toBe(true),
    );
    f.storage.finishDownloads();
    await vi.waitFor(async () =>
      expect(await f.read()).toBe(['console while metadata loads', systemLine].join('\n')),
    );
  } finally {
    poll.abort();
    f.storage.finishDownloads();
    await firstRead.catch(() => {});
    await f.reader[Symbol.asyncDispose]();
  }
});

test.each([401, 500])(
  'log metadata HTTP %s remains visible to the shared recovery policy',
  async (status) => {
    const f = await logFixture({ failFileStatus: status });
    try {
      await vi.waitFor(async () => {
        await expect(f.read()).rejects.toMatchObject({
          code: 'COMMAND_FAILED',
          details: { statusCode: status },
        });
      });
      expect(f.streams.every((stream) => vi.mocked(stream.stop).mock.calls.length === 1)).toBe(
        true,
      );
    } finally {
      await f.reader[Symbol.asyncDispose]();
    }
  },
);

test('a new log reader returns retained app output on its first poll', async () => {
  const f = await logFixture();
  vi.mocked(f.client.appLogTail).mockResolvedValue('before reconnect\nlast line');
  try {
    expect(await f.read()).toBe('before reconnect\nlast line');
  } finally {
    await f.reader[Symbol.asyncDispose]();
  }
});
