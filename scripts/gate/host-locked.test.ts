// `pnpm gate` serializes heavy gates behind the host validation lock and leaves cheap ones alone.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CHECK_CATALOG } from '../check-affected/checks.ts';
import { acquireValidationLock, VALIDATION_PARENT_ENV } from '../check-affected/host-lock.ts';
import { executeGate, requiresHostLock } from './host-locked.ts';

const skip = process.platform === 'win32';
const cleanEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env[VALIDATION_PARENT_ENV];
  delete env.GITHUB_ACTIONS;
  return { ...env, ...extra };
};

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-host-lock-'));
  const lockDirPath = path.join(directory, 'gate.lock');
  const marker = path.join(directory, 'marker');
  const writeMarker = [
    process.execPath,
    '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.env.${VALIDATION_PARENT_ENV} ?? '')`,
  ];
  return {
    lockDirPath,
    marker,
    writeMarker,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

test('the locked gates are the whole-repo suites and worker-spawning sweeps', () => {
  assert.deepEqual(
    CHECK_CATALOG.filter((spec) => spec.hostLocked)
      .map((spec) => spec.id)
      .sort(),
    [
      'concurrency-torture',
      'fuzz-parsers',
      'mutation',
      'mutation-affected',
      'provider-integration',
      'unit',
      'unit-ci',
    ],
  );
});

test(
  'unit-ci waits for the host lock owner, then runs under it and releases it',
  { skip },
  async () => {
    const { lockDirPath, marker, writeMarker, cleanup } = fixture();
    try {
      const owner = await acquireValidationLock(
        new AbortController().signal,
        lockDirPath,
        () => {},
        cleanEnv(),
      );
      let waitReport = '';
      const waiting = executeGate({
        id: 'unit-ci',
        command: writeMarker,
        cwd: process.cwd(),
        env: cleanEnv(),
        lockDirPath,
        report: (message) => {
          waitReport = message;
        },
      });
      await new Promise<void>((resolve) => {
        const poll = setInterval(() => {
          if (waitReport) {
            clearInterval(poll);
            resolve();
          }
        }, 20);
      });
      assert.match(waitReport, /\[wait\] host validation/);
      assert.equal(
        fs.existsSync(marker),
        false,
        'gate must not run while another owner holds the lock',
      );
      await owner.release();
      assert.equal(await waiting, 0);
      assert.equal(fs.readFileSync(marker, 'utf8'), 'gate:unit-ci');
      assert.equal(fs.existsSync(lockDirPath), false, 'gate must release the lock');
      assert.equal(fs.existsSync(`${lockDirPath}.active.json`), false);
    } finally {
      cleanup();
    }
  },
);

test(
  'a locked gate returns the command exit code and still releases the lock',
  { skip },
  async () => {
    const { lockDirPath, cleanup } = fixture();
    try {
      const exitCode = await executeGate({
        id: 'unit-ci',
        command: [process.execPath, '-e', 'process.exit(7)'],
        cwd: process.cwd(),
        env: cleanEnv(),
        lockDirPath,
      });
      assert.equal(exitCode, 7);
      assert.equal(fs.existsSync(lockDirPath), false);
    } finally {
      cleanup();
    }
  },
);

test(
  'a gate inside a locked validation inherits the owner instead of deadlocking',
  { skip },
  async () => {
    const { lockDirPath, marker, writeMarker, cleanup } = fixture();
    try {
      const owner = await acquireValidationLock(
        new AbortController().signal,
        lockDirPath,
        () => {},
        cleanEnv(),
      );
      const env = cleanEnv({ [VALIDATION_PARENT_ENV]: '/parent/receipt.json' });
      assert.equal(requiresHostLock('unit-ci', env), false);
      const exitCode = await executeGate({
        id: 'unit-ci',
        command: writeMarker,
        cwd: process.cwd(),
        env,
        lockDirPath,
        report: () => assert.fail('nested gate must not wait'),
      });
      assert.equal(exitCode, 0);
      assert.equal(fs.readFileSync(marker, 'utf8'), '/parent/receipt.json');
      assert.ok(fs.existsSync(lockDirPath), 'nested gate must not release the parent lock');
      await owner.release();
    } finally {
      cleanup();
    }
  },
);

test('cheap gates and GitHub runners do not wait for the lock', { skip }, async () => {
  const { lockDirPath, marker, writeMarker, cleanup } = fixture();
  try {
    const owner = await acquireValidationLock(
      new AbortController().signal,
      lockDirPath,
      () => {},
      cleanEnv(),
    );
    for (const [id, env] of [
      ['lint', cleanEnv()],
      ['unit-ci', cleanEnv({ GITHUB_ACTIONS: 'true' })],
    ] as const) {
      fs.rmSync(marker, { force: true });
      assert.equal(requiresHostLock(id, env), false, id);
      const exitCode = await executeGate({
        id,
        command: writeMarker,
        cwd: process.cwd(),
        env,
        lockDirPath,
        report: () => assert.fail(`${id} must not wait`),
      });
      assert.equal(exitCode, 0);
      assert.equal(fs.readFileSync(marker, 'utf8'), '');
    }
    assert.ok(fs.existsSync(lockDirPath), 'unlocked gates leave the owner in place');
    await owner.release();
  } finally {
    cleanup();
  }
});

test(
  'a signal while waiting cancels the gate and leaves the owner in place',
  { skip },
  async () => {
    const { lockDirPath, marker, writeMarker, cleanup } = fixture();
    try {
      const owner = await acquireValidationLock(
        new AbortController().signal,
        lockDirPath,
        () => {},
        cleanEnv(),
      );
      const waiting = executeGate({
        id: 'unit-ci',
        command: writeMarker,
        cwd: process.cwd(),
        env: cleanEnv(),
        lockDirPath,
        report: () => void process.emit('SIGTERM'),
      });
      assert.equal(await waiting, 143);
      assert.equal(fs.existsSync(marker), false);
      assert.ok(fs.existsSync(lockDirPath), 'cancelled waiter must not release the owner');
      await owner.release();
    } finally {
      cleanup();
    }
  },
);

test(
  'a signal while the locked command runs stops it and still releases the lock',
  { skip },
  async () => {
    const { lockDirPath, marker, cleanup } = fixture();
    try {
      const running = executeGate({
        id: 'unit-ci',
        command: [
          process.execPath,
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)`,
        ],
        cwd: process.cwd(),
        env: cleanEnv(),
        lockDirPath,
      });
      await new Promise<void>((resolve) => {
        const poll = setInterval(() => {
          if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8')) {
            clearInterval(poll);
            resolve();
          }
        }, 20);
      });
      assert.ok(
        fs.existsSync(`${lockDirPath}.active.json`),
        'ownership is published while running',
      );
      process.emit('SIGTERM');
      assert.equal(await running, 143);
      assert.throws(() => process.kill(Number(fs.readFileSync(marker, 'utf8')), 0), /ESRCH/);
      assert.equal(fs.existsSync(lockDirPath), false, 'gate must release the lock');
      assert.equal(fs.existsSync(`${lockDirPath}.active.json`), false);
    } finally {
      cleanup();
    }
  },
);
