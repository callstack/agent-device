import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  coerceExecResult,
  commandDeveloperDir,
  commandHostEnvironment,
  isCommandTimeoutError,
  requireExecSuccess,
  runCmd,
  runCmdBackground,
  runCmdDetached,
  runCmdStreaming,
  runCmdSync,
  whichCmd,
  withCommandHost,
  type ExecResult,
} from './exec.ts';
import { AppError } from '@agent-device/kernel/errors';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';

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

test('runCmdBackground aborts with request cancellation details', async () => {
  const controller = new AbortController();
  const { wait } = runCmdBackground(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], {
    signal: controller.signal,
  });
  controller.abort();

  await assertRejectsRequestCanceled(wait);
});

test('whichCmd resolves absolute executable paths without invoking a shell', async () => {
  assert.equal(await whichCmd(process.execPath, process.env), true);
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
  assert.equal(await whichCmd('node', process.env), true);
});

test.runIf(process.platform !== 'win32')(
  'process helpers reject relative executable paths',
  async () => {
    const root = mkdtempForTestSync('agent-device-runcmd-relative-');
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
    const root = mkdtempForTestSync('agent-device-runcmd-absolute-');
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
  assert.equal(await whichCmd('node; rm -rf /', process.env), false);
  assert.equal(await whichCmd('./node', process.env), false);
});

test('whichCmd ignores directories that match a command name in PATH', async () => {
  const root = mkdtempForTestSync('agent-device-whichcmd-');
  const fakeCommandDir = path.join(root, 'fake-tool');
  fs.mkdirSync(fakeCommandDir);

  try {
    const env = { PATH: `${root}${path.delimiter}${process.env.PATH ?? ''}` };
    assert.equal(await whichCmd('fake-tool', env), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('requireExecSuccess passes a zero-exit result through untouched', () => {
  const result: ExecResult = { stdout: 'ok', stderr: '', exitCode: 0 };
  assert.equal(
    requireExecSuccess(result, 'should not throw', () => {
      throw new Error('extra must not be evaluated on success');
    }),
    result,
  );
});

test('requireExecSuccess throws a flagged COMMAND_FAILED with lazy extras on failure', () => {
  const result: ExecResult = { stdout: 'out', stderr: 'boom\n', exitCode: 3 };
  try {
    requireExecSuccess(result, 'tool failed', (failed) => ({ hint: `saw ${failed.exitCode}` }));
    assert.fail('expected requireExecSuccess to throw');
  } catch (error) {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'COMMAND_FAILED');
    assert.equal(error.message, 'tool failed');
    assert.equal(error.details?.processExitError, true);
    assert.equal(error.details?.stderr, 'boom\n');
    assert.equal(error.details?.exitCode, 3);
    assert.equal(error.details?.hint, 'saw 3');
  }
});

test('coerceExecResult repairs loosely-typed provider results and keeps typed ones identical', () => {
  const typed: ExecResult = { stdout: 'a', stderr: 'b', exitCode: 0 };
  assert.equal(coerceExecResult(typed), typed);

  const loose = coerceExecResult({
    stdout: undefined,
    stderr: 42,
    exitCode: undefined,
  } as unknown as ExecResult);
  assert.deepEqual(loose, { stdout: '', stderr: '42', exitCode: 1 });
});

test('isCommandTimeoutError reads the structured timeout, not the message text', async () => {
  const killedAtTimeout = await runCmd(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], {
    timeoutMs: 50,
  }).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(isCommandTimeoutError(killedAtTimeout));

  assert.ok(
    isCommandTimeoutError(
      (() => {
        try {
          runCmdSync(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], { timeoutMs: 50 });
          return null;
        } catch (error) {
          return error;
        }
      })(),
    ),
  );

  // A tool that failed on its own and said "timed out" in its output: same
  // code, same wording, no timeout we imposed.
  assert.equal(
    isCommandTimeoutError(
      new AppError('COMMAND_FAILED', 'xcodebuild timed out after 10ms', { cmd: 'xcodebuild' }),
    ),
    false,
  );
  assert.equal(isCommandTimeoutError(new Error('timed out after 10ms')), false);
  assert.equal(isCommandTimeoutError(undefined), false);
});

const PRINT_DEVELOPER_DIR = ['-e', 'process.stdout.write(process.env.DEVELOPER_DIR ?? "")'];

function hostWith(env: Record<string, string | undefined>): HostEnvironment {
  return { env: { ...process.env, ...env }, cwd: process.cwd() };
}

test('a request command env reaches spawned commands; outside it they inherit the host env', async () => {
  const host = hostWith({ DEVELOPER_DIR: '/daemon/Developer' });
  const inherited = await runCmd(process.execPath, PRINT_DEVELOPER_DIR, { env: host.env });
  assert.equal(inherited.stdout, '/daemon/Developer');

  const [first, second, unscoped, hostOnly] = await Promise.all([
    withCommandHost({ host, requestEnv: { DEVELOPER_DIR: '/a/Developer' } }, async () =>
      runCmd(process.execPath, PRINT_DEVELOPER_DIR, { env: host.env }),
    ),
    withCommandHost({ host, requestEnv: { DEVELOPER_DIR: '/b/Developer' } }, async () =>
      runCmdSync(process.execPath, PRINT_DEVELOPER_DIR),
    ),
    withCommandHost({ host, requestEnv: undefined }, async () =>
      runCmd(process.execPath, PRINT_DEVELOPER_DIR, { env: host.env }),
    ),
    withCommandHost({ host, requestEnv: undefined }, async () =>
      runCmd(process.execPath, PRINT_DEVELOPER_DIR),
    ),
  ]);
  assert.equal(first.stdout, '/a/Developer');
  assert.equal(second.stdout, '/b/Developer');
  assert.equal(unscoped.stdout, '/daemon/Developer');
  assert.equal(hostOnly.stdout, '/daemon/Developer');
});

const PRINT_TZ_AND_LOCALE = [
  '-e',
  'process.stdout.write(`${process.env.TZ ?? ""}|${process.env.LC_ALL ?? ""}`)',
];

test('envOverrides are the final word over the bound host environment, keeping TZ under a locale pin', async () => {
  // Overrides merge over the effective child env instead of replacing it, so an `LC_ALL=C` pin
  // alone still lets `TZ` through; the lstart probe itself pins `TZ=UTC` on top (host-process).
  const host = hostWith({ TZ: 'Pacific/Kiritimati' });
  const [pinned, requestEnvOverridden] = await Promise.all([
    withCommandHost({ host, requestEnv: undefined }, async () =>
      runCmd(process.execPath, PRINT_TZ_AND_LOCALE, { envOverrides: { LC_ALL: 'C' } }),
    ),
    withCommandHost({ host, requestEnv: { LC_ALL: 'fr_FR.UTF-8' } }, async () =>
      runCmd(process.execPath, PRINT_TZ_AND_LOCALE, { envOverrides: { LC_ALL: 'C' } }),
    ),
  ]);
  assert.equal(pinned.stdout, 'Pacific/Kiritimati|C');
  assert.equal(
    requestEnvOverridden.stdout,
    'Pacific/Kiritimati|C',
    'the override is the final word, ahead of the request env too',
  );
});

test.runIf(process.platform !== 'win32')(
  'xcrun tool-not-found failures name the developer dir and how to change it',
  async () => {
    const binDir = mkdtempForTestSync('agent-device-exec-xcrun-');
    const xcrun = path.join(binDir, 'xcrun');
    fs.writeFileSync(
      xcrun,
      '#!/bin/sh\necho \'xcrun: error: unable to find utility "simctl", not a developer tool or in PATH\' >&2\nexit 72\n',
      { mode: 0o755 },
    );
    await assert.rejects(
      withCommandHost(
        {
          host: hostWith({}),
          requestEnv: { DEVELOPER_DIR: '/Library/Developer/CommandLineTools' },
        },
        async () => runCmd(xcrun, ['simctl', 'list']),
      ),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.details?.reason, 'xcrun-tool-not-found');
        assert.equal(error.details?.developerDir, '/Library/Developer/CommandLineTools');
        assert.match(
          String(error.details?.hint),
          /simctl in DEVELOPER_DIR \/Library\/Developer\/CommandLineTools/,
        );
        assert.match(String(error.details?.hint), /xcode-select -s/);
        return true;
      },
    );
  },
);

const XCRUN_DEVICECTL_NOT_FOUND = {
  stdout: '',
  stderr: 'xcrun: error: unable to find utility "devicectl", not a developer tool or in PATH\n',
  exitCode: 72,
};

test('an allowFailure xcrun result guarded by requireExecSuccess gets the toolchain hint over the caller hint', async () => {
  await assert.rejects(
    withCommandHost(
      {
        host: hostWith({}),
        requestEnv: { DEVELOPER_DIR: '/Library/Developer/CommandLineTools' },
      },
      async () =>
        requireExecSuccess(XCRUN_DEVICECTL_NOT_FOUND, 'Failed to install app', {
          cmd: 'xcrun',
          args: ['devicectl', 'device', 'install', 'app'],
          hint: 'Ensure the iOS device is unlocked, trusted, and available in Xcode > Devices, then retry.',
        }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.message, 'Failed to install app');
      assert.equal(error.details?.reason, 'xcrun-tool-not-found');
      assert.match(
        String(error.details?.hint),
        /^xcrun could not find devicectl in DEVELOPER_DIR \/Library\/Developer\/CommandLineTools\./,
      );
      return true;
    },
  );
});

test('without a developer dir the toolchain hint points at xcode-select', async () => {
  await withCommandHost(
    { host: hostWith({ DEVELOPER_DIR: undefined }), requestEnv: undefined },
    async () => {
      // No cmd/args: the call site only had the result, so xcrun's own stderr identifies the tool.
      assert.throws(
        () => requireExecSuccess(XCRUN_DEVICECTL_NOT_FOUND, 'Failed to list devices'),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.details?.developerDir, null);
          assert.match(
            String(error.details?.hint),
            /devicectl in the developer dir selected by xcode-select/,
          );
          return true;
        },
      );
    },
  );
});

test('a request that clears DEVELOPER_DIR is not reported under the daemon one', async () => {
  const host = hostWith({ DEVELOPER_DIR: '/daemon/Developer' });
  // The child runs without a usable DEVELOPER_DIR (xcode-select decides), so the key and report
  // must too, whether the request clears it or carries it unset.
  for (const requestEnv of [{ DEVELOPER_DIR: '' }, { DEVELOPER_DIR: undefined }]) {
    await withCommandHost({ host, requestEnv }, async () => {
      assert.equal((await runCmd(process.execPath, PRINT_DEVELOPER_DIR)).stdout, '');
      assert.equal(commandDeveloperDir(), undefined);
      assert.throws(
        () => requireExecSuccess(XCRUN_DEVICECTL_NOT_FOUND, 'Failed to list devices'),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.details?.developerDir, null);
          assert.match(String(error.details?.hint), /selected by xcode-select/);
          return true;
        },
      );
    });
  }
  await withCommandHost({ host, requestEnv: undefined }, async () => {
    assert.equal(commandDeveloperDir(), '/daemon/Developer');
  });
});

test('a non-xcrun failure keeps the caller hint', () => {
  assert.throws(
    () =>
      requireExecSuccess({ stdout: '', stderr: 'boom', exitCode: 72 }, 'Failed', {
        cmd: 'adb',
        hint: 'caller hint',
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.hint, 'caller hint');
      assert.equal(error.details?.reason, undefined);
      return true;
    },
  );
});

test('runCmdStreaming can forward output without retaining it in the result', async () => {
  let stdout = '';
  let stderr = '';
  const result = await runCmdStreaming(
    process.execPath,
    ['-e', "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 7;"],
    {
      allowFailure: true,
      captureOutput: false,
      onStdoutChunk: (chunk) => {
        stdout += chunk;
      },
      onStderrChunk: (chunk) => {
        stderr += chunk;
      },
    },
  );
  assert.equal(stdout, 'out');
  assert.equal(stderr, 'err');
  assert.deepEqual(result, { stdout: '', stderr: '', exitCode: 7, stdoutBuffer: undefined });
});

test('commandHostEnvironment names the enclosing host and refuses outside one', async () => {
  assert.throws(
    () => commandHostEnvironment(),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.reason, 'host_environment_unscoped');
      return true;
    },
  );

  const host = hostWith({ AGENT_DEVICE_TEST_HOST: 'yes' });
  await withCommandHost({ host, requestEnv: undefined }, async () => {
    assert.equal(commandHostEnvironment(), host);
  });
});

// Windows reports no signal for a terminated process.
test.skipIf(process.platform === 'win32')(
  'every foreground executor reports the signal that ended the process',
  async () => {
    const kill = ['-e', "process.kill(process.pid, 'SIGKILL')"];
    const options = { allowFailure: true };

    assert.equal((await runCmd(process.execPath, kill, options)).signal, 'SIGKILL');
    assert.equal((await runCmdStreaming(process.execPath, kill, options)).signal, 'SIGKILL');
    assert.equal(runCmdSync(process.execPath, kill, options).signal, 'SIGKILL');

    const exited = await runCmd(process.execPath, ['-e', 'process.exit(3)'], options);
    assert.equal(exited.exitCode, 3);
    assert.equal('signal' in exited, false);
  },
);

const PRINT_ENV_NAMES = [
  '-e',
  'process.stdout.write(["SECRET_VAR", "KEEP_VAR"].map((n) => `${n}=${process.env[n] ?? "unset"}`).join(" "))',
];

test('envOmit deletes child env names that envOverrides cannot drop', async () => {
  const host = hostWith({ SECRET_VAR: 'hunter2', KEEP_VAR: 'plain' });
  const [omitted, kept, overrideCannotDrop] = await Promise.all([
    withCommandHost({ host, requestEnv: undefined }, async () =>
      runCmd(process.execPath, PRINT_ENV_NAMES, { envOmit: ['SECRET_VAR'] }),
    ),
    withCommandHost({ host, requestEnv: undefined }, async () =>
      runCmd(process.execPath, PRINT_ENV_NAMES),
    ),
    withCommandHost({ host, requestEnv: undefined }, async () =>
      runCmd(process.execPath, PRINT_ENV_NAMES, { envOverrides: { SECRET_VAR: undefined } }),
    ),
  ]);
  assert.equal(omitted.stdout, 'SECRET_VAR=unset KEEP_VAR=plain');
  assert.equal(kept.stdout, 'SECRET_VAR=hunter2 KEEP_VAR=plain');
  // The undefined override drops the name too; envOmit exists so callers state deletion, not a
  // value cast to undefined.
  assert.equal(overrideCannotDrop.stdout, 'SECRET_VAR=unset KEEP_VAR=plain');
});

const ECHO_ARG_AND_FAIL = [
  '-e',
  'process.stderr.write(`echoing ${process.argv[1]}\\n`); process.exit(9);',
];

test('redactions scrub the error argv and the child output of a failing streaming run', async () => {
  const secret = '/secrets/AuthKey_ABCDEF1234.p8';
  let stderrSeen = '';
  const failure = await runCmdStreaming(process.execPath, [...ECHO_ARG_AND_FAIL, secret], {
    redactions: [secret],
    onStderrChunk: (chunk) => {
      stderrSeen += chunk;
    },
  }).catch((error: unknown) => error as AppError);

  assert.ok(failure instanceof AppError, 'the run fails');
  const rawArgs = (failure.details as { args?: string[] } | undefined)?.args ?? [];
  assert.ok(rawArgs.includes('[redacted]'), 'the error argv carries the placeholder');
  assert.equal(
    rawArgs.some((arg) => arg.includes('AuthKey')),
    false,
    'the error argv never carries the key path',
  );
  assert.equal(stderrSeen.includes('AuthKey'), false, 'the chunk callback never sees the path');
  assert.equal(stderrSeen.includes('[redacted]'), true, 'the chunk sees the placeholder');
  assert.equal(String(failure.details?.stderr ?? '').includes('AuthKey'), false);
});

test('a secret split across chunk boundaries is still one redaction', async () => {
  // The child writes the secret one character at a time, so the scrubber's held tail is exercised
  // at every split point in one run.
  const secret = '/secrets/AuthKey_ABCDEF1234.p8';
  const script = '-e';
  const body = 'for (const ch of process.argv[1]) { process.stdout.write(ch); }';
  let stdoutSeen = '';
  await runCmdStreaming(process.execPath, [script, body, secret], {
    redactions: [secret],
    onStdoutChunk: (chunk) => {
      stdoutSeen += chunk;
    },
  });
  assert.equal(stdoutSeen.includes('AuthKey'), false, 'no chunk callback ever sees the path');
  assert.equal(
    stdoutSeen.includes('[redacted]'),
    true,
    'the joined chunks collapse to the placeholder',
  );
  assert.equal(
    stdoutSeen.replace(/\[redacted\]/g, '').length,
    0,
    'nothing but the placeholder remains',
  );
});

test('redactions scrub a timeout error argv too', async () => {
  const secret = '/secrets/AuthKey_ABCDEF1234.p8';
  await assert.rejects(
    runCmdStreaming(
      process.execPath,
      ['-e', 'process.stderr.write(process.argv[1]); setTimeout(() => {}, 10_000);', secret],
      { timeoutMs: 200, redactions: [secret] },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      const rawArgs = (error.details as { args?: string[] } | undefined)?.args ?? [];
      assert.equal(rawArgs.at(-1), '[redacted]');
      assert.equal(
        rawArgs.some((arg) => arg.includes('AuthKey')),
        false,
      );
      assert.equal(String(error.details?.stderr ?? '').includes('AuthKey'), false);
      return true;
    },
  );
});

test('a redacted key path scrubs from the streams while flag names and key ids stay', async () => {
  // The runner build echoes its whole command line, flag names included, so the child receives the
  // real invocation shape. Only the value the caller redacts may vanish; the flags and the
  // non-secret key ids must survive so the log still names what the build carried.
  const keyPath = '/secrets/AuthKey_ABCDEF1234.p8';
  const keyId = 'KID12345';
  const issuerId = 'ISSUER67890';
  const invocation = [
    '-allowProvisioningUpdates',
    '-authenticationKeyPath',
    keyPath,
    '-authenticationKeyID',
    keyId,
    '-authenticationKeyIssuerID',
    issuerId,
  ];
  let stdoutSeen = '';
  let stderrSeen = '';
  const result = await runCmdStreaming(
    process.execPath,
    [
      '-e',
      [
        "process.stdout.write(process.argv.slice(1).join(' '));",
        "process.stderr.write(`quoted '-authenticationKeyPath' ${JSON.stringify(process.argv[3])}`);",
      ].join(''),
      '--',
      ...invocation,
    ],
    {
      redactions: [keyPath],
      onStdoutChunk: (chunk) => {
        stdoutSeen += chunk;
      },
      onStderrChunk: (chunk) => {
        stderrSeen += chunk;
      },
    },
  );
  for (const [face, text] of [
    ['stdout chunk', stdoutSeen],
    ['stdout retained', result.stdout],
  ] as const) {
    assert.equal(text.includes(keyPath), false, `${face} carries the key path`);
    assert.ok(text.includes('[redacted]'), `${face} carries the placeholder`);
    assert.ok(text.includes('-authenticationKeyPath'), `${face} keeps the path flag name`);
    assert.ok(text.includes('-authenticationKeyIssuerID'), `${face} keeps the issuer flag name`);
    assert.ok(text.includes(keyId), `${face} keeps the key id`);
    assert.ok(text.includes(issuerId), `${face} keeps the issuer id`);
  }
  for (const [face, text] of [
    ['stderr chunk', stderrSeen],
    ['stderr retained', result.stderr],
  ] as const) {
    assert.equal(text.includes(keyPath), false, `${face} carries the key path`);
    assert.ok(text.includes('[redacted]'), `${face} carries the placeholder`);
    assert.ok(text.includes('-authenticationKeyPath'), `${face} keeps the flag name`);
  }
});

test('a stream cut mid-echo masks the held key-path fragment at close', async () => {
  // The child dies after echoing most of the path. The held tail is a proper prefix of the secret,
  // so the close flush must mask it instead of releasing a recognizable fragment.
  const keyPath = '/secrets/AuthKey_ABCDEF1234.p8';
  const cutEcho = keyPath.slice(0, keyPath.length - 6);
  let stdoutSeen = '';
  const result = await runCmdStreaming(
    process.execPath,
    ['-e', `process.stdout.write(${JSON.stringify(`echoing ${cutEcho}`)})`],
    { redactions: [keyPath], onStdoutChunk: (chunk) => (stdoutSeen += chunk) },
  );
  assert.equal(stdoutSeen.includes('AuthKey'), false, 'a chunk carries the cut-off fragment');
  assert.ok(stdoutSeen.includes('[redacted]'), 'the close flush masks the held fragment');
  assert.equal(result.stdout.includes('AuthKey'), false, 'the retained output keeps the fragment');
});

test('a spawn failure with redactions carries no raw argv in the error', async () => {
  const secret = '/secrets/AuthKey_ABCDEF1234.p8';
  const failure = await runCmdStreaming('/no/such/agent-device-tool', [secret], {
    redactions: [secret],
  }).catch((error: unknown) => error as AppError);
  assert.ok(failure instanceof AppError, 'the spawn failure is an AppError');
  assert.equal(
    JSON.stringify(failure).includes(secret),
    false,
    'the spawn error never carries the path',
  );
});

test('without redactions the streams and error argv stay byte for byte', async () => {
  const echoed =
    '-authenticationKeyPath /secrets/AuthKey_ABCDEF1234.p8 -authenticationKeyID KID12345';
  const result = await runCmdStreaming(process.execPath, [
    '-e',
    `process.stdout.write(${JSON.stringify(echoed)})`,
    '--',
    echoed,
  ]);
  assert.equal(result.stdout, echoed, 'the retained output is untouched');
  const failure = await runCmdStreaming(process.execPath, [
    '-e',
    'process.exit(3)',
    '--',
    echoed,
  ]).catch((error: unknown) => error as AppError);
  assert.ok(failure instanceof AppError, 'the failing run is an AppError');
  assert.deepEqual(
    failure.details?.args,
    ['-e', 'process.exit(3)', '--', echoed],
    'the argv is raw',
  );
});

test('envOmit deletes from the inherited environment outside a host scope', async () => {
  const inheritedName = 'AGENT_DEVICE_TEST_ENV_OMIT_INHERITED';
  const child = [
    '-e',
    `process.stdout.write(process.env[${JSON.stringify(inheritedName)}] ?? 'unset')`,
  ];
  process.env[inheritedName] = 'inherited-value';
  try {
    const [omitted, kept] = await Promise.all([
      runCmd(process.execPath, child, { envOmit: [inheritedName] }),
      runCmd(process.execPath, child),
    ]);
    assert.equal(omitted.stdout, 'unset', 'the omitted name is absent for the child');
    assert.equal(kept.stdout, 'inherited-value', 'without envOmit the child inherits the value');
  } finally {
    delete process.env[inheritedName];
  }
});

test('envOmit deletes a name even when envOverrides sets the same name', async () => {
  const result = await runCmd(process.execPath, PRINT_ENV_NAMES, {
    env: { SECRET_VAR: 'base-value', KEEP_VAR: 'plain' },
    envOverrides: { SECRET_VAR: 'override-value' },
    envOmit: ['SECRET_VAR'],
  });
  assert.equal(result.stdout, 'SECRET_VAR=unset KEEP_VAR=plain');
});

test('envOmit naming absent variables leaves the child environment byte for byte', async () => {
  const env = { SECRET_VAR: 'hunter2', KEEP_VAR: 'plain' };
  const [withOmit, without] = await Promise.all([
    runCmd(process.execPath, PRINT_ENV_NAMES, {
      env,
      envOmit: ['AGENT_DEVICE_TEST_ENV_OMIT_ABSENT'],
    }),
    runCmd(process.execPath, PRINT_ENV_NAMES, { env }),
  ]);
  assert.equal(withOmit.stdout, without.stdout);
});
