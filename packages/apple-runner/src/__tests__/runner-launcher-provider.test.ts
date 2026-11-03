import { expect, test, vi } from 'vitest';
import { createLaunchedAppleRunnerProvider } from '../runner-launcher-provider.ts';
import type { RunnerLauncher } from '../runner-launcher.ts';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { appleRunnerTestHost } from '../test-host.ts';

// A launcher is the production boundary for remote work; it has no local PID or artifact.
test('managed launch preparation consumes the same explicit startup budget as local preparation', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100_000);
  const localTool = vi.fn(() => {
    throw new Error('Managed launch reached local tooling');
  });
  appleRunnerTestHost.update({ runXcrun: localTool, runCmdBackground: localTool });
  let finish!: () => void;
  const exited = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const launcher: RunnerLauncher = {
    endpoint: { port: 8100, http: { url: 'https://instance.invalid/command' } },
    async launch() {
      clock.mockReturnValue(150_000);
      return {
        exited,
        output: (async function* () {
          yield '';
          await exited;
        })(),
        terminate: async () => {
          finish();
        },
      };
    },
  };
  const provider = createLaunchedAppleRunnerProvider(IOS_SIMULATOR, launcher, {});
  try {
    const session = await provider.ensure({ startupTimeoutMs: 60_000 });
    expect(session.launchDeadline?.remainingMs()).toBe(10_000);
    expect(session.launch.local).toBeUndefined();
    expect(session.xctestrunArtifact).toBeUndefined();
    expect(localTool).not.toHaveBeenCalled();
  } finally {
    await provider.stop();
    clock.mockRestore();
  }
});

for (const operation of ['stop', 'release'] as const) {
  test(`${operation} cancels a pending launch and admits a subsequent generation`, async () => {
    let attempts = 0;
    let entered!: () => void;
    const launching = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: () => void;
    const exited = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const provider = createLaunchedAppleRunnerProvider(
      IOS_SIMULATOR,
      {
        endpoint: { port: 8100, http: { url: 'https://instance.invalid/command' } },
        async launch(_endpoint, signal) {
          attempts++;
          if (attempts === 1) {
            entered();
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
          }
          return {
            exited,
            output: (async function* () {
              yield '';
              await exited;
            })(),
            terminate: async () => {
              finish();
            },
          };
        },
      },
      {},
    );
    try {
      const starting = provider.ensure({});
      const canceled = expect(starting).rejects.toMatchObject({
        details: { runnerStartRetired: true },
      });
      await launching;
      if (operation === 'stop') await provider.stop();
      else await provider.release(false);
      await canceled;
      await provider.ensure({});
      expect(attempts).toBe(2);
    } finally {
      await provider.stop();
    }
  });
}

test('a failed termination stays owned and blocks replacement until termination succeeds', async () => {
  let attempts = 0;
  let failTermination = true;
  let finish!: () => void;
  const provider = createLaunchedAppleRunnerProvider(
    IOS_SIMULATOR,
    {
      endpoint: { port: 8100, http: { url: 'https://instance.invalid/command' } },
      async launch() {
        attempts++;
        const exited = new Promise<void>((resolve) => {
          finish = resolve;
        });
        return {
          exited,
          output: (async function* () {
            yield '';
            await exited;
          })(),
          terminate: async () => {
            if (failTermination) throw new Error('termination unavailable');
            finish();
          },
        };
      },
    },
    {},
  );
  try {
    await provider.ensure({});
    await expect(provider.stop()).rejects.toMatchObject({
      details: { reason: 'runner_termination_failed' },
    });
    await expect(provider.ensure({})).rejects.toMatchObject({
      details: { reason: 'runner_termination_failed' },
    });
    expect(attempts).toBe(1);
    failTermination = false;
    await provider.ensure({});
    expect(attempts).toBe(2);
  } finally {
    failTermination = false;
    await provider.stop();
  }
});

test('an output failure and failed termination remain observable without an unhandled rejection', async () => {
  let failTermination = true;
  let failOutput!: () => void;
  let finish!: () => void;
  const outputFailure = new Promise<void>((resolve) => {
    failOutput = resolve;
  });
  const exited = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const provider = createLaunchedAppleRunnerProvider(
    IOS_SIMULATOR,
    {
      endpoint: { port: 8100, http: { url: 'https://instance.invalid/command' } },
      async launch() {
        return {
          exited,
          output: (async function* () {
            yield '';
            await outputFailure;
            throw new Error('output lost');
          })(),
          terminate: async () => {
            if (failTermination) throw new Error('termination unavailable');
            finish();
          },
        };
      },
    },
    {},
  );
  try {
    const session = await provider.ensure({});
    failOutput();
    await expect(session.launch?.output).resolves.toBeUndefined();
    expect(session.state).toBe('draining');
    await expect(provider.ensure({})).rejects.toMatchObject({
      details: { reason: 'runner_termination_failed' },
    });
  } finally {
    failTermination = false;
    await provider.stop();
  }
});

test('retained reopen shares a generation and an exited generation flushes logs before replacement', async () => {
  const { startFakeRunnerServer } = await import('./fake-runner-server.ts');
  const { mkdtempForTestSync } = await import('./tmp-dir.ts');
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const server = await startFakeRunnerServer({});
  const logPath = path.join(mkdtempForTestSync('managed-runner-'), 'runner.log');
  let attempts = 0;
  let finish!: () => void;
  const provider = createLaunchedAppleRunnerProvider(
    IOS_SIMULATOR,
    {
      endpoint: { port: server.port, http: { url: `http://127.0.0.1:${server.port}/command` } },
      async launch() {
        const generation = ++attempts;
        const exited = new Promise<void>((resolve) => {
          finish = resolve;
        });
        return {
          exited,
          output: (async function* () {
            await exited;
            yield `generation ${generation} ended\n`;
          })(),
          terminate: async () => {
            finish();
          },
        };
      },
    },
    { AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS: '0' },
  );
  try {
    const first = await provider.ensure({ logPath });
    await provider.runCommand(IOS_SIMULATOR, { command: 'uptime' }, { logPath });
    await provider.release(true);
    const retained = await provider.ensure({ logPath });
    expect(retained.sessionId).toBe(first.sessionId);
    expect(attempts).toBe(1);
    expect(server.requests.some((request) => request.command === 'shutdown')).toBe(false);
    finish();
    await first.launch?.output;
    expect(provider.hasLiveSession()).toBe(false);
    const replacement = await provider.ensure({ logPath });
    expect(replacement.sessionId).not.toBe(first.sessionId);
    expect(replacement.endpoint.token).not.toBe(first.endpoint.token);
    expect(attempts).toBe(2);
    expect(await readFile(logPath, 'utf8')).toContain('generation 1 ended');
  } finally {
    await provider.stop();
    await server.close();
  }
});

test('a canceled launch retains a generation whose termination failed before publication', async () => {
  let attempts = 0;
  let failTermination = true;
  let finish!: () => void;
  const cancellation = new AbortController();
  const provider = createLaunchedAppleRunnerProvider(
    IOS_SIMULATOR,
    {
      endpoint: { port: 8100, http: { url: 'https://instance.invalid/command' } },
      async launch() {
        attempts++;
        const exited = new Promise<void>((resolve) => {
          finish = resolve;
        });
        cancellation.abort(new Error('caller left'));
        return {
          exited,
          output: (async function* () {
            yield '';
            await exited;
          })(),
          terminate: async () => {
            if (failTermination) throw new Error('termination unavailable');
            finish();
          },
        };
      },
    },
    {},
  );
  try {
    await expect(provider.ensure({ signal: cancellation.signal })).rejects.toMatchObject({
      details: { reason: 'request_canceled' },
    });
    await expect(provider.ensure({})).rejects.toMatchObject({
      details: { reason: 'runner_termination_failed' },
    });
    expect(attempts).toBe(1);
    failTermination = false;
    await provider.ensure({});
    expect(attempts).toBe(2);
  } finally {
    failTermination = false;
    await provider.stop();
  }
});

test('an immediate output failure cannot publish a draining generation as ready', async () => {
  let attempts = 0;
  let failTermination = true;
  let finish!: () => void;
  const provider = createLaunchedAppleRunnerProvider(
    IOS_SIMULATOR,
    {
      endpoint: { port: 8100, http: { url: 'https://instance.invalid/command' } },
      async launch() {
        const generation = ++attempts;
        const exited = new Promise<void>((resolve) => {
          finish = resolve;
        });
        return {
          exited,
          output: (async function* () {
            if (generation === 1) throw new Error('output lost before publication');
            yield '';
            await exited;
          })(),
          terminate: async () => {
            if (failTermination) throw new Error('termination unavailable');
            finish();
          },
        };
      },
    },
    {},
  );
  try {
    await expect(provider.ensure({})).rejects.toMatchObject({
      details: { reason: 'runner_termination_failed' },
    });
    await expect(provider.ensure({})).rejects.toMatchObject({
      details: { reason: 'runner_termination_failed' },
    });
    expect(attempts).toBe(1);
    failTermination = false;
    await provider.ensure({});
    expect(attempts).toBe(2);
  } finally {
    failTermination = false;
    await provider.stop();
  }
});

for (const operation of ['abort', 'stop'] as const) {
  test(`global ${operation} finishes all sweeps after a registered termination fails`, async () => {
    const { abortAllIosRunnerSessions, stopAllIosRunnerSessions } =
      await import('../runner-session.ts');
    let failRegistered = true;
    const registered = (suffix: string, shouldFail: () => boolean) => {
      let finish!: () => void;
      const exited = new Promise<void>((resolve) => {
        finish = resolve;
      });
      return createLaunchedAppleRunnerProvider(
        { ...IOS_SIMULATOR, id: `${IOS_SIMULATOR.id}-${suffix}` },
        {
          endpoint: { port: 8100, http: { url: 'https://instance.invalid/command' } },
          async launch() {
            return {
              exited,
              output: (async function* () {
                yield '';
                await exited;
              })(),
              async terminate() {
                if (shouldFail()) throw new Error('registered termination unavailable');
                finish();
              },
            };
          },
        },
        {},
      );
    };
    const failing = registered('failed-stop', () => failRegistered);
    const healthy = registered('healthy-stop', () => false);
    await failing.ensure({});
    await healthy.ensure({});
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let aborted!: () => void;
    const canceled = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finish!: () => void;
    const exited = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let failTermination = true;
    const provider = createLaunchedAppleRunnerProvider(
      IOS_SIMULATOR,
      {
        endpoint: { port: 8100, http: { url: 'https://instance.invalid/command' } },
        async launch(_endpoint, signal) {
          signal.addEventListener('abort', aborted, { once: true });
          enter();
          await held;
          return {
            exited,
            output: (async function* () {
              yield '';
              await exited;
            })(),
            terminate: async () => {
              if (failTermination) throw new Error('termination unavailable');
              finish();
            },
          };
        },
      },
      {},
    );
    try {
      const starting = provider.ensure({});
      const failedStart = expect(starting).rejects.toMatchObject({
        details: { reason: 'runner_termination_failed' },
      });
      await entered;
      const shutdown =
        operation === 'abort' ? abortAllIosRunnerSessions() : stopAllIosRunnerSessions();
      let shutdownSettled = false;
      const shutdownResult = shutdown.then(
        () => ({ status: 'resolved' as const, error: undefined }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );
      void shutdownResult.then(() => {
        shutdownSettled = true;
      });
      await canceled;
      await new Promise<void>((resolve) => setImmediate(resolve));
      const waitedForLaunch = !shutdownSettled;
      release();
      await failedStart;
      const result = await shutdownResult;
      expect(waitedForLaunch).toBe(true);
      expect(result.status).toBe('rejected');
      expect(result.error).toBeInstanceOf(AggregateError);
      expect(provider.isStarted()).toBe(true);
      expect(failing.isStarted()).toBe(true);
      expect(healthy.isStarted()).toBe(false);
    } finally {
      failTermination = false;
      failRegistered = false;
      release();
      await Promise.all([provider.stop(), failing.stop(), healthy.stop()]);
    }
  });
}
