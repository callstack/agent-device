import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { tryAdoptRunnerSessionFromLease } from '../runner-adoption.ts';
import { notifyIosRunnerAppRelaunched, prepareIosRunner } from '../runner-client.ts';
import { RUNNER_COMMAND_TRAITS } from '../runner-command-traits.ts';
import type { RunnerCommand } from '../runner-contract.ts';
import { disposeRunnerSession } from '../runner-disposal.ts';
import { buildRunnerLease, writeRunnerLease } from '../runner-lease.ts';
import { executeRunnerCommand, prepareLocalIosRunner } from '../runner-lifecycle.ts';
import { withAppleRunnerProvider } from '../runner-provider.ts';
import {
  assertProducedRunnerRequests,
  readRunnerRequestFixture,
  REPO_ROOT,
} from '../runner-requests.fixtures.ts';
import { runApplePressSeries } from '../runner-sequence.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { startFakeRunnerServer, type FakeRunnerServer } from './fake-runner-server.ts';
import { makeRunnerSession } from './runner-session-fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

const runnerState = vi.hoisted(() => ({ ensureRunnerSession: vi.fn(), derivedPath: '' }));

vi.mock('../runner-session.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../runner-session.ts')>()),
  ensureRunnerSession: runnerState.ensureRunnerSession,
}));

vi.mock('../runner-xctestrun.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../runner-xctestrun.ts')>()),
  resolveExpectedRunnerCacheMetadata: () => ({}),
  resolveRunnerDerivedPath: () => runnerState.derivedPath,
}));

const APP = 'com.example.app';

let server: FakeRunnerServer | undefined;
let scratch: string;

beforeEach(() => {
  scratch = mkdtempForTestSync('agent-device-runner-contract-');
  runnerState.derivedPath = path.join(scratch, 'derived');
  process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR = path.join(scratch, 'leases');
});

afterEach(async () => {
  delete process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR;
  await server?.close();
  server = undefined;
});

test('runner-internal request sites build exactly their runner-requests.json entries', async () => {
  const sent: RunnerCommand[] = [];
  await withAppleRunnerProvider(
    async (_device, request) => {
      sent.push(request);
      return {};
    },
    { deviceId: IOS_SIMULATOR.id },
    async () => await prepareIosRunner(IOS_SIMULATOR, { healthTimeoutMs: 1_000 }),
  );

  server = await startFakeRunnerServer({
    targetReset: [{ kind: 'hangUp' }],
    status: [
      {
        kind: 'ok',
        data: { lifecycleState: 'completed', lifecycleResponseJson: '{"ok":true,"data":{}}' },
      },
    ],
  });
  const session = makeRunnerSession({
    port: server.port,
    xctestrunPath: path.join(scratch, 'runner.xctestrun'),
    jsonPath: path.join(scratch, 'runner.json'),
  });
  runnerState.ensureRunnerSession.mockResolvedValue(session);
  appleRunnerTestHost.update({
    isProcessAlive: () => false,
    isProcessGroupAlive: () => false,
    runXcrun: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  });
  await prepareLocalIosRunner(IOS_SIMULATOR, { healthTimeoutMs: 5_000 });
  await runApplePressSeries(
    IOS_SIMULATOR,
    { x: 10, y: 20 },
    { button: 'primary', count: 2, intervalMs: 0, holdMs: 0, jitterPx: 0, doubleTap: false },
    APP,
    async (request) => await executeRunnerCommand(IOS_SIMULATOR, request, {}),
  );
  await notifyIosRunnerAppRelaunched(IOS_SIMULATOR);
  await disposeRunnerSession(session);

  appleRunnerTestHost.update({
    isProcessAlive: () => true,
    readProcessCommand: () => null,
    readProcessStartTime: () => 'test-process-start',
  });
  writeRunnerLease({
    ...buildRunnerLease({
      device: IOS_SIMULATOR,
      sessionId: `${IOS_SIMULATOR.id}:${server.port}:1`,
      runnerPid: 424242,
      port: server.port,
      xctestrunPath: path.join(runnerState.derivedPath, 'Build', 'Products', 'r.xctestrun'),
      jsonPath: path.join(runnerState.derivedPath, 'Build', 'Products', 'r.json'),
    }),
    ownerToken: 'owner-99999-deadbeef',
    ownerPid: 99999,
    ownerStartTime: 'not-a-real-start-time',
  });
  assert.ok(await tryAdoptRunnerSessionFromLease(IOS_SIMULATOR, {}), 'the lease was not adopted');

  const received = server.requests.map((request) => request.body);
  assert.deepEqual(
    received.map((request) => request.command),
    ['uptime', 'uptime', 'sequence', 'targetReset', 'status', 'shutdown', 'uptime'],
  );
  assertProducedRunnerRequests(import.meta.filename, [
    ['ios-simulator.runner-client-prepare.uptime', sent[0]],
    ['ios-simulator.runner-lifecycle-prepare.uptime', received[0]],
    ['ios-simulator.runner-session-readiness.uptime', received[1]],
    ['ios-simulator.runner-client-target-reset.relaunch', received[3]],
    ['ios-simulator.runner-command-recovery.status', received[4]],
    ['ios-simulator.runner-disposal.shutdown', received[5]],
    ['ios-simulator.runner-adoption.uptime', received[6]],
  ]);
});

test('runner-requests.json has a production request for every runner command', () => {
  const entries = readRunnerRequestFixture();
  const names = entries.map((entry) => entry.name);
  assert.deepEqual(names, [...new Set(names)].sort());
  const produced = new Set(entries.map((entry) => entry.request.command));
  assert.deepEqual(
    Object.keys(RUNNER_COMMAND_TRAITS).filter((name) => !produced.has(name)),
    [],
    'runner commands with no production request',
  );
  for (const producer of new Set(entries.map((entry) => entry.producer))) {
    const source = fs.readFileSync(path.join(REPO_ROOT, producer), 'utf8');
    assert.ok(
      producer.endsWith('runner-requests.test.ts') &&
        source.includes('assertProducedRunnerRequests(import.meta.filename'),
      `${producer} must be a dedicated *runner-requests.test.ts drive that checks its own entries`,
    );
  }
});

const REQUEST_LITERAL = /\bcommand\s*:(?!\s*RunnerCommand\b)/;
const DIRECT_SEND = new RegExp(
  `\\b(?:${['runAppleRunnerCommand', 'executeRunnerCommandWithSession', 'waitForRunner', 'sendRunnerCommandOnce'].join('|')})\\s*\\(`,
);

test('runner request drives send only requests production builds', () => {
  const producers = readRunnerRequestFixture().map((entry) => path.join(REPO_ROOT, entry.producer));
  const sources = [
    ...new Set(producers),
    path.join(import.meta.dirname, '../runner-requests.fixtures.ts'),
    path.join(import.meta.dirname, '../../__tests__/recording-runner-provider.ts'),
  ];
  const offending = sources.flatMap((file) =>
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, index) =>
        REQUEST_LITERAL.test(line) || DIRECT_SEND.test(line)
          ? [`${path.relative(REPO_ROOT, file)}:${index + 1}: ${line.trim()}`]
          : [],
      ),
  );
  assert.deepEqual(offending, []);
});
