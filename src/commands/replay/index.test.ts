import { afterEach, describe, expect, test } from 'vitest';
import type { CliFlags } from '../cli-grammar/flag-types.ts';
import {
  replayCliReader,
  replayCommandDefinition,
  replayCommandMetadata,
  replayDaemonWriter,
  testCliReader,
  testCommandDefinition,
  testCommandMetadata,
  testDaemonWriter,
} from './index.ts';

const ORIGINAL_AD_VAR = process.env.AD_VAR_REPLAY_TEST;

function flags(overrides: Partial<CliFlags> = {}): CliFlags {
  return overrides as CliFlags;
}

function expectInvalidArgs(fn: () => unknown, messageFragment: string) {
  expect(fn).toThrow(
    expect.objectContaining({
      code: 'INVALID_ARGS',
      message: expect.stringContaining(messageFragment),
    }),
  );
}

afterEach(() => {
  if (ORIGINAL_AD_VAR === undefined) {
    delete process.env.AD_VAR_REPLAY_TEST;
  } else {
    process.env.AD_VAR_REPLAY_TEST = ORIGINAL_AD_VAR;
  }
});

describe('replay command interface', () => {
  test('owns replay and test public metadata', () => {
    expect(replayCommandMetadata.name).toBe('replay');
    expect(replayCommandDefinition.name).toBe('replay');
    expect(testCommandMetadata.name).toBe('test');
    expect(testCommandDefinition.name).toBe('test');
  });

  test('reads replay CLI input', () => {
    expect(
      replayCliReader(
        ['./checkout.ad'],
        flags({
          replayUpdate: true,
          replayMaestro: true,
          replayEnv: ['FOO=bar'],
          metroHost: '127.0.0.1',
          metroPort: 8083,
          bundleUrl: 'http://127.0.0.1:8083/index.bundle',
        }),
      ),
    ).toEqual({
      path: './checkout.ad',
      update: true,
      backend: 'maestro',
      env: ['FOO=bar'],
      metroHost: '127.0.0.1',
      metroPort: 8083,
      bundleUrl: 'http://127.0.0.1:8083/index.bundle',
    });
  });

  test('rejects missing replay path', () => {
    expectInvalidArgs(() => replayCliReader([], flags()), 'replay requires path');
  });

  test('reads test CLI input', () => {
    expect(
      testCliReader(
        ['./suite-a.ad', './suite-b.ad'],
        flags({
          replayUpdate: true,
          replayMaestro: true,
          replayEnv: ['FOO=bar'],
          metroHost: '127.0.0.1',
          metroPort: 8083,
          bundleUrl: 'http://127.0.0.1:8083/index.bundle',
          failFast: true,
          timeoutMs: 10_000,
          retries: 2,
          recordVideo: true,
          artifactsDir: './artifacts',
          shardAll: 4,
          shardSplit: 2,
        }),
      ),
    ).toMatchObject({
      paths: ['./suite-a.ad', './suite-b.ad'],
      update: true,
      backend: 'maestro',
      env: ['FOO=bar'],
      metroHost: '127.0.0.1',
      metroPort: 8083,
      bundleUrl: 'http://127.0.0.1:8083/index.bundle',
      failFast: true,
      timeoutMs: 10_000,
      retries: 2,
      recordVideo: true,
      artifactsDir: './artifacts',
      shardAll: 4,
      shardSplit: 2,
    });
  });

  test('writes daemon replay and test requests with replay flags', () => {
    process.env.AD_VAR_REPLAY_TEST = 'enabled';
    expect(
      replayDaemonWriter({
        path: './checkout.ad',
        update: true,
        backend: 'maestro',
        env: ['FOO=bar'],
      }),
    ).toMatchObject({
      command: 'replay',
      positionals: ['./checkout.ad'],
      options: {
        replayUpdate: true,
        replayBackend: 'maestro',
        replayEnv: ['FOO=bar'],
        replayShellEnv: { AD_VAR_REPLAY_TEST: 'enabled' },
      },
    });

    const testRequest = testDaemonWriter({
      paths: ['./suite.ad'],
      maestro: true,
      metroHost: '127.0.0.1',
      metroPort: 8083,
      reportJunit: './junit.xml',
    });
    expect(testRequest).toMatchObject({
      command: 'test',
      positionals: ['./suite.ad'],
      options: {
        replayBackend: 'maestro',
        metroHost: '127.0.0.1',
        metroPort: 8083,
      },
    });
    expect(testRequest.options).not.toHaveProperty('reportJunit');
  });

  test('folds replay and test Metro hints into the runtime request envelope', async () => {
    const runCalls: unknown[] = [];
    const testCalls: unknown[] = [];
    const client = {
      replay: {
        run: async (input: unknown) => {
          runCalls.push(input);
          return {};
        },
        test: async (input: unknown) => {
          testCalls.push(input);
          return {};
        },
      },
    } as never;
    const runtimeFlags = flags({
      metroHost: '127.0.0.1',
      metroPort: 8083,
      bundleUrl: 'http://127.0.0.1:8083/index.bundle',
    });

    await replayCommandDefinition.invoke(client, replayCliReader(['./flow.ad'], runtimeFlags));
    await testCommandDefinition.invoke(client, testCliReader(['./suite'], runtimeFlags));

    const runtime = {
      metroHost: '127.0.0.1',
      metroPort: 8083,
      bundleUrl: 'http://127.0.0.1:8083/index.bundle',
      launchUrl: undefined,
    };
    expect(runCalls[0]).toMatchObject({ path: './flow.ad', runtime });
    expect(testCalls[0]).toMatchObject({ paths: ['./suite'], runtime });
    expect(runCalls[0]).not.toHaveProperty('metroHost');
    expect(testCalls[0]).not.toHaveProperty('metroPort');
  });
});

describe('replay resume (ADR 0012 decision 4 / migration step 5)', () => {
  test('reads --from/--plan-digest as resumeFrom/resumePlanDigest, replay only', () => {
    expect(
      replayCliReader(['./checkout.ad'], flags({ replayFrom: 3, replayPlanDigest: 'deadbeef' })),
    ).toMatchObject({
      path: './checkout.ad',
      resumeFrom: 3,
      resumePlanDigest: 'deadbeef',
    });
  });

  test('test CLI reader never surfaces resume fields, even if the flags carry them', () => {
    const input = testCliReader(
      ['./suite.ad'],
      flags({ replayFrom: 3, replayPlanDigest: 'deadbeef' } as never),
    );
    expect(input).not.toHaveProperty('resumeFrom');
    expect(input).not.toHaveProperty('resumePlanDigest');
  });

  test('writes resumeFrom/resumePlanDigest onto the daemon request as replayFrom/replayPlanDigest', () => {
    expect(
      replayDaemonWriter({
        path: './checkout.ad',
        resumeFrom: 3,
        resumePlanDigest: 'deadbeef',
      }),
    ).toMatchObject({
      command: 'replay',
      positionals: ['./checkout.ad'],
      options: {
        replayFrom: 3,
        replayPlanDigest: 'deadbeef',
      },
    });
  });

  test('test daemon writer never emits replayFrom/replayPlanDigest', () => {
    const request = testDaemonWriter({ paths: ['./suite.ad'] });
    expect(request.options).not.toHaveProperty('replayFrom');
    expect(request.options).not.toHaveProperty('replayPlanDigest');
  });
});

describe('replay --save-script arming (ADR 0012 decision 6, R1/R6)', () => {
  test('reads --save-script as a boolean flag', () => {
    expect(replayCliReader(['./checkout.ad'], flags({ saveScript: true }))).toMatchObject({
      path: './checkout.ad',
      saveScript: true,
    });
  });

  test('reads --save-script=<out> as its output path string', () => {
    expect(
      replayCliReader(['./checkout.ad'], flags({ saveScript: './flows/checkout.healed.ad' })),
    ).toMatchObject({
      path: './checkout.ad',
      saveScript: './flows/checkout.healed.ad',
    });
  });

  test('writes saveScript onto the daemon request unchanged', () => {
    expect(replayDaemonWriter({ path: './checkout.ad', saveScript: true })).toMatchObject({
      command: 'replay',
      positionals: ['./checkout.ad'],
      options: { saveScript: true },
    });
    expect(replayDaemonWriter({ path: './checkout.ad', saveScript: './out.ad' })).toMatchObject({
      command: 'replay',
      positionals: ['./checkout.ad'],
      options: { saveScript: './out.ad' },
    });
  });

  test('test does not accept --save-script at all', () => {
    expect(testCliReader(['./suite.ad'], flags({ saveScript: true } as never))).not.toHaveProperty(
      'saveScript',
    );
  });
});
