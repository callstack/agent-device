import { expect, test } from 'vitest';
import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { deviceShellArgv } from '@agent-device/kernel/device-shell';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import {
  isCommandTimeoutError,
  withCommandExecutorOverride,
  type ExecOptions,
} from '@agent-device/host-kit/command';
import { createHostCommandRunner } from './platform-runtime-host-command-runner.ts';

/** A child that answers only after a pause, so a deadline or a cancel always arrives first. */
const DELAYED_CHILD = ['-e', 'setTimeout(() => process.stdout.write("finished"), 300)'];

type DispatchedCommand = Readonly<{
  command: string;
  args: readonly string[];
  cwd: string | undefined;
  env: ExecOptions['env'];
  timeoutMs: number | undefined;
  allowFailure: boolean | undefined;
}>;

/**
 * Records each command the port dispatches and answers it as a success, so a test names the options
 * the port composed without running anything.
 */
async function withRecordedDispatch<T>(
  run: (dispatched: DispatchedCommand[]) => Promise<T>,
): Promise<T> {
  const dispatched: DispatchedCommand[] = [];
  return await withCommandExecutorOverride(
    (command, args, options) => {
      dispatched.push({
        command,
        args,
        cwd: options.cwd,
        env: options.env,
        timeoutMs: options.timeoutMs,
        allowFailure: options.allowFailure,
      });
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    },
    async () => await run(dispatched),
  );
}

test.skipIf(process.platform === 'win32')(
  'the port resolves an executable through the host environment it was built with',
  async () => {
    const directory = mkdtempForTestSync('host-command-runner-which-');
    const tool = path.join(directory, 'probe-tool');
    writeFileSync(tool, '#!/bin/sh\nexit 0\n');
    chmodSync(tool, 0o755);
    const commands = createHostCommandRunner({ env: { PATH: directory }, cwd: directory });

    await expect(commands.which('probe-tool')).resolves.toBe('probe-tool');
    // The host's PATH is the whole answer: a name it does not carry stays unresolved however the
    // process environment looks.
    await expect(
      commands.which('agent-device-command-runner-probe-absent'),
    ).resolves.toBeUndefined();
  },
);

test('the port answers with the stdout, stderr and exit code of the command it ran', async () => {
  const commands = createHostCommandRunner({ env: process.env, cwd: process.cwd() });

  // The three fields of the host command result, and nothing the spawn carried beside them.
  await expect(
    commands.run({
      executable: process.execPath,
      args: ['-e', 'console.log("to-stdout"); console.error("to-stderr"); process.exit(3);'],
      allowFailure: true,
    }),
  ).resolves.toStrictEqual({ stdout: 'to-stdout\n', stderr: 'to-stderr\n', exitCode: 3 });
});

test('the port maps a request onto the command it dispatches', async () => {
  const commands = createHostCommandRunner({
    env: Object.freeze({ PROBE: 'from-host', PATH: '/host/path' }),
    cwd: '/host-cwd',
  });
  const args = deviceShellArgv('adb', 'shell', ['whoami']);

  await withRecordedDispatch(async (dispatched) => {
    await commands.run({
      executable: 'adb',
      args,
      cwd: '/request-cwd',
      env: { PROBE: 'from-request', ADDED: 'by-request' },
      timeoutMs: 1_500,
      allowFailure: true,
    });

    expect(dispatched).toEqual([
      {
        command: 'adb',
        args,
        cwd: '/request-cwd',
        env: { PROBE: 'from-request', PATH: '/host/path', ADDED: 'by-request' },
        timeoutMs: 1_500,
        allowFailure: true,
      },
    ]);
    // The array the funnel built is the one handed on, not a copy of it.
    expect(dispatched[0]?.args).toBe(args);
  });
});

test('a request that names no environment is dispatched without one', async () => {
  // Handing the host snapshot down here would replace the environment the enclosing command host owns
  // with what this host captured at startup, which an unmentioned request must not do.
  const commands = createHostCommandRunner({
    env: Object.freeze({ PROBE: 'from-host', PATH: '/host/path' }),
    cwd: '/host-cwd',
  });

  await withRecordedDispatch(async (dispatched) => {
    await commands.run({ executable: 'probe-tool', args: [] });

    expect(dispatched).toEqual([
      {
        command: 'probe-tool',
        args: [],
        cwd: undefined,
        env: undefined,
        timeoutMs: undefined,
        allowFailure: undefined,
      },
    ]);
  });
});

test('the port refuses a device-shell request the funnel did not build, before dispatching', async () => {
  const commands = createHostCommandRunner({ env: process.env, cwd: process.cwd() });

  await withRecordedDispatch(async (dispatched) => {
    await expect(commands.run({ executable: 'adb', args: ['shell', 'whoami'] })).rejects.toThrow(
      expect.objectContaining({
        code: 'INVALID_ARGS',
        details: expect.objectContaining({ reason: 'unguarded-device-shell-argv' }),
      }),
    );

    expect(dispatched).toEqual([]);
  });
});

test('the deadline a request names bounds the command the port runs', async () => {
  const commands = createHostCommandRunner({ env: process.env, cwd: process.cwd() });

  await expect(
    commands.run({ executable: process.execPath, args: DELAYED_CHILD, timeoutMs: 100 }),
  ).rejects.toSatisfy(isCommandTimeoutError);
});

test('the optional signal cancels the command the port is running', async () => {
  const commands = createHostCommandRunner({ env: process.env, cwd: process.cwd() });
  const controller = new AbortController();
  const running = commands.run(
    { executable: process.execPath, args: DELAYED_CHILD },
    controller.signal,
  );
  controller.abort();

  await expect(running).rejects.toSatisfy(isRequestCanceledError);
});
