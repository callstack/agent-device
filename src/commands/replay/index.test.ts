import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { CliFlags } from '@agent-device/contracts/command';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
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

// #1802: the daemon writers READ the scripts they name, so writer cases need real files. `cwd` is
// the caller's working directory the writer resolves relative paths against — the CLI passes
// `process.cwd()`, and pinning it here is what proves the resolution happens caller-side.
const SCRIPT_ROOT = mkdtempForTestSync('agent-device-replay-writer-');
const CHECKOUT_SCRIPT = 'open "Demo"\nclick "Checkout"\n';
for (const name of ['checkout.ad', 'probe-hang.ad', 'suite.ad', 'flow.ad']) {
  fs.writeFileSync(path.join(SCRIPT_ROOT, name), CHECKOUT_SCRIPT);
}
fs.mkdirSync(path.join(SCRIPT_ROOT, 'suite'), { recursive: true });
fs.writeFileSync(path.join(SCRIPT_ROOT, 'suite', '01-first.ad'), CHECKOUT_SCRIPT);

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

  test('writes daemon replay and test requests with replay flags', async () => {
    process.env.AD_VAR_REPLAY_TEST = 'enabled';
    expect(
      await replayDaemonWriter({
        path: './checkout.ad',
        cwd: SCRIPT_ROOT,
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

    const testRequest = await testDaemonWriter({
      paths: ['./suite.ad'],
      cwd: SCRIPT_ROOT,
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

  test('projects replay --timeout into the daemon request envelope', async () => {
    const input = replayCliReader(['./probe-hang.ad'], flags({ timeoutMs: 1_000 }));

    expect(input).toMatchObject({ path: './probe-hang.ad', timeoutMs: 1_000 });
    expect(await replayDaemonWriter({ ...input, cwd: SCRIPT_ROOT })).toMatchObject({
      command: 'replay',
      positionals: ['./probe-hang.ad'],
      options: { timeoutMs: 1_000 },
    });
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

  test('writes resumeFrom/resumePlanDigest onto the daemon request as replayFrom/replayPlanDigest', async () => {
    expect(
      await replayDaemonWriter({
        path: './checkout.ad',
        cwd: SCRIPT_ROOT,
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

  test('test daemon writer never emits replayFrom/replayPlanDigest', async () => {
    const request = await testDaemonWriter({ paths: ['./suite.ad'], cwd: SCRIPT_ROOT });
    expect(request.options).not.toHaveProperty('replayFrom');
    expect(request.options).not.toHaveProperty('replayPlanDigest');
  });
});

describe('replay --keep-session', () => {
  test('projects the CLI flag through structured replay input and the daemon request', async () => {
    const input = replayCliReader(['./checkout.ad'], flags({ replayKeepSession: true }));
    expect(input).toMatchObject({ path: './checkout.ad', keepSession: true });
    expect(await replayDaemonWriter({ ...input, cwd: SCRIPT_ROOT })).toMatchObject({
      command: 'replay',
      positionals: ['./checkout.ad'],
      options: { replayKeepSession: true },
    });
    expect(replayCommandMetadata.inputSchema.properties).toHaveProperty('keepSession');
  });

  test('test exposes and forwards no keep-session option', async () => {
    const input = testCliReader(['./suite.ad'], flags({ replayKeepSession: true } as never));
    expect(input).not.toHaveProperty('keepSession');
    expect(testCommandMetadata.inputSchema.properties).not.toHaveProperty('keepSession');
    expect((await testDaemonWriter({ ...input, cwd: SCRIPT_ROOT })).options).not.toHaveProperty(
      'replayKeepSession',
    );
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

  test('writes saveScript onto the daemon request unchanged', async () => {
    expect(
      await replayDaemonWriter({ path: './checkout.ad', cwd: SCRIPT_ROOT, saveScript: true }),
    ).toMatchObject({
      command: 'replay',
      positionals: ['./checkout.ad'],
      options: { saveScript: true },
    });
    expect(
      await replayDaemonWriter({ path: './checkout.ad', cwd: SCRIPT_ROOT, saveScript: './out.ad' }),
    ).toMatchObject({
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
