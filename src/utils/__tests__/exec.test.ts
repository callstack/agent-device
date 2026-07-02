import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flushDiagnosticsToSessionFile, withDiagnosticsScope } from '../diagnostics.ts';
import {
  runCmd,
  runCmdBackground,
  runCmdDetached,
  runCmdStreaming,
  runCmdSync,
  whichCmd,
} from '../exec.ts';

test('runCmd enforces timeoutMs and rejects with COMMAND_FAILED', async () => {
  await assert.rejects(
    runCmd(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], { timeoutMs: 100 }),
    (error: unknown) => {
      const err = error as { code?: string; message?: string; details?: Record<string, unknown> };
      return (
        err?.code === 'COMMAND_FAILED' &&
        typeof err?.message === 'string' &&
        err.message.includes('timed out') &&
        err.details?.timeoutMs === 100
      );
    },
  );
});

test('runCmd aborts with request cancellation details', async () => {
  const controller = new AbortController();
  const promise = runCmd(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], {
    signal: controller.signal,
  });
  controller.abort();

  await assertRejectsRequestCanceled(promise);
});

test('runCmd abort keeps cancellation details while writing stdin', async () => {
  const controller = new AbortController();
  const promise = runCmd(
    process.execPath,
    ['-e', ['process.stdin.resume();', 'setTimeout(() => {}, 10_000);'].join('')],
    {
      signal: controller.signal,
      stdin: Buffer.alloc(512_000, 'a'),
    },
  );
  controller.abort();

  await assertRejectsRequestCanceled(promise);
});

test('runCmd emits exec_command diagnostics when the scope is debug-enabled', async () => {
  const logPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-exec-debug-')),
    'diag.ndjson',
  );
  const diagnosticsPath = await withDiagnosticsScope(
    {
      session: 'exec-debug',
      requestId: 'exec-debug-1',
      command: 'debug',
      debug: true,
      logPath,
    },
    async () => {
      await runCmd(process.execPath, ['-e', 'process.stdout.write("ok")']);
      return flushDiagnosticsToSessionFile();
    },
  );

  const execEvent = readExecDiagnosticEvent(diagnosticsPath);
  assert.equal(execEvent?.level, 'debug');
  assert.equal(execEvent?.phase, 'exec_command');
  assert.equal(execEvent?.data?.command, process.execPath);
  assert.deepEqual(execEvent?.data?.argsPrefix, ['-e', 'process.stdout.write("ok")']);
  assert.equal(execEvent?.data?.omittedArgCount, undefined);
  assert.equal(typeof execEvent?.durationMs, 'number');
});

test('runCmd writes stdin through pipeline', async () => {
  const stdin = Buffer.alloc(256_000, 'a');
  const result = await runCmd(
    process.execPath,
    [
      '-e',
      [
        'let bytes = 0;',
        'process.stdin.on("data", chunk => { bytes += chunk.length; });',
        'process.stdin.on("end", () => process.stdout.write(String(bytes)));',
      ].join(''),
    ],
    { stdin },
  );

  assert.equal(result.stdout, String(stdin.length));
});

test.sequential('runCmdBackground emits bounded exec_command diagnostics when AGENT_DEVICE_EXEC_TRACE is enabled', async () => {
  const diagnosticsPath = await withExecTraceEnv(
    async () =>
      await withDiagnosticsScope(
        {
          session: 'exec-trace',
          requestId: 'exec-trace-1',
          command: 'background',
        },
        async () => {
          const { wait } = runCmdBackground(process.execPath, [
            '-e',
            'process.stdout.write("ok")',
            'a',
            'b',
            'c',
            'd',
            'e',
            'f',
          ]);
          await wait;
          return flushDiagnosticsToSessionFile();
        },
      ),
  );

  assertBackgroundExecTraceEvents(readExecDiagnosticEvents(diagnosticsPath));
});

test('runCmdBackground can leave output streams to the caller', async () => {
  const { child, wait } = runCmdBackground(
    process.execPath,
    ['-e', 'process.stdout.write("out"); process.stderr.write("err");'],
    { captureOutput: false },
  );
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });

  const result = await wait;

  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(stdout, 'out');
  assert.equal(stderr, 'err');
});

test.sequential('runCmd stays silent when exec tracing is not enabled', async () => {
  const previousTraceEnv = process.env.AGENT_DEVICE_EXEC_TRACE;
  delete process.env.AGENT_DEVICE_EXEC_TRACE;

  try {
    const diagnosticsPath = await withDiagnosticsScope(
      {
        session: 'exec-silent',
        requestId: 'exec-silent-1',
        command: 'home',
      },
      async () => {
        await runCmd(process.execPath, ['-e', 'process.stdout.write("ok")']);
        return flushDiagnosticsToSessionFile();
      },
    );

    assert.equal(diagnosticsPath, null);
  } finally {
    if (previousTraceEnv !== undefined) {
      process.env.AGENT_DEVICE_EXEC_TRACE = previousTraceEnv;
    }
  }
});

test('runCmdBackground aborts with request cancellation details', async () => {
  const controller = new AbortController();
  const { wait } = runCmdBackground(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], {
    signal: controller.signal,
  });
  controller.abort();

  await assertRejectsRequestCanceled(wait);
});

test('whichCmd resolves absolute executable paths without invoking a shell', async () => {
  assert.equal(await whichCmd(process.execPath), true);
});

async function assertRejectsRequestCanceled(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    const err = error as { code?: string; message?: string; details?: Record<string, unknown> };
    return (
      err?.code === 'COMMAND_FAILED' &&
      err.message === 'request canceled' &&
      err.details?.reason === 'request_canceled'
    );
  });
}

test('whichCmd resolves bare commands from PATH', async () => {
  assert.equal(await whichCmd('node'), true);
});

test.runIf(process.platform !== 'win32')(
  'process helpers reject relative executable paths',
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-runcmd-relative-'));
    const target = path.join(root, 'local-node');
    fs.symlinkSync(process.execPath, target);

    try {
      await assert.rejects(
        runCmd('./local-node', ['-e', 'process.stdout.write("ok")'], {
          cwd: root,
        }),
        { code: 'INVALID_ARGS' },
      );
      await assert.rejects(
        runCmdStreaming('./local-node', ['-e', 'process.stdout.write("ok")'], {
          cwd: root,
        }),
        { code: 'INVALID_ARGS' },
      );
      assert.throws(
        () =>
          runCmdSync('./local-node', ['-e', 'process.stdout.write("ok")'], {
            cwd: root,
          }),
        { code: 'INVALID_ARGS' },
      );
      assert.throws(
        () =>
          runCmdDetached('./local-node', ['-e', 'process.stdout.write("ok")'], {
            cwd: root,
          }),
        { code: 'INVALID_ARGS' },
      );
      assert.throws(
        () =>
          runCmdBackground('./local-node', ['-e', 'process.stdout.write("ok")'], {
            cwd: root,
          }),
        { code: 'INVALID_ARGS' },
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test.runIf(process.platform !== 'win32')(
  'runCmd accepts absolute executable paths without shell execution',
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-runcmd-absolute-'));
    const target = path.join(root, 'local-node');
    fs.symlinkSync(process.execPath, target);

    try {
      const result = await runCmd(target, ['-e', 'process.stdout.write("ok")'], {
        cwd: root,
      });
      assert.equal(result.stdout, 'ok');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test('whichCmd rejects suspicious command strings', async () => {
  assert.equal(await whichCmd('node; rm -rf /'), false);
  assert.equal(await whichCmd('./node'), false);
});

test.sequential('whichCmd ignores directories that match a command name in PATH', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-whichcmd-'));
  const fakeCommandDir = path.join(root, 'fake-tool');
  fs.mkdirSync(fakeCommandDir);

  const previousPath = process.env.PATH;
  process.env.PATH = `${root}${path.delimiter}${previousPath ?? ''}`;

  try {
    assert.equal(await whichCmd('fake-tool'), false);
  } finally {
    process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function readExecDiagnosticEvents(diagnosticsPath: string | null): Array<{
  level?: string;
  phase?: string;
  durationMs?: number;
  data?: Record<string, unknown>;
}> {
  if (!diagnosticsPath) return [];
  const rows = fs
    .readFileSync(diagnosticsPath, 'utf8')
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as {
          level?: string;
          phase?: string;
          durationMs?: number;
          data?: Record<string, unknown>;
        },
    );
  return rows.filter((row) => row.phase === 'exec_command');
}

function readExecDiagnosticEvent(diagnosticsPath: string | null): {
  level?: string;
  phase?: string;
  durationMs?: number;
  data?: Record<string, unknown>;
} | null {
  return readExecDiagnosticEvents(diagnosticsPath)[0] ?? null;
}

async function withExecTraceEnv<T>(fn: () => Promise<T>): Promise<T> {
  const previousTraceEnv = process.env.AGENT_DEVICE_EXEC_TRACE;
  process.env.AGENT_DEVICE_EXEC_TRACE = '1';
  try {
    return await fn();
  } finally {
    restoreOptionalEnv('AGENT_DEVICE_EXEC_TRACE', previousTraceEnv);
  }
}

function restoreOptionalEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function assertBackgroundExecTraceEvents(
  execEvents: Array<{
    level?: string;
    phase?: string;
    durationMs?: number;
    data?: Record<string, unknown>;
  }>,
): void {
  assert.deepEqual(execEvents.map(summarizeExecEvent), [
    {
      phase: 'exec_command',
      command: process.execPath,
      event: 'spawn',
      durationType: 'undefined',
      argsPrefix: ['-e', 'process.stdout.write("ok")', 'a', 'b', 'c', 'd'],
      omittedArgCount: 2,
    },
    {
      phase: 'exec_command',
      command: process.execPath,
      event: 'exit',
      durationType: 'number',
      argsPrefix: ['-e', 'process.stdout.write("ok")', 'a', 'b', 'c', 'd'],
      omittedArgCount: 2,
    },
  ]);
}

function summarizeExecEvent(event: {
  phase?: string;
  durationMs?: number;
  data?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    phase: event.phase,
    command: event.data?.command,
    event: event.data?.event,
    durationType: typeof event.durationMs,
    argsPrefix: event.data?.argsPrefix,
    omittedArgCount: event.data?.omittedArgCount,
  };
}
