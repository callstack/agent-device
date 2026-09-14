import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { readMacosProcesses } from '../../../packages/host-kit/src/internal/macos-process.ts';
import {
  readProcessCommand,
  readProcessStartTime,
  isProcessZombie,
  readHostProcessIdentityObservations,
  listHostProcesses,
} from '../../../packages/host-kit/src/internal/host-process.ts';
import { classifyOwnerLiveness } from '../../../packages/host-kit/src/internal/owner-identity.ts';

const [mode, sentinel, checker, expectedStart] = process.argv.slice(2);
if (mode === 'denied') {
  assert.deepEqual(readMacosProcesses([process.pid]), []);
} else {
  assert.throws(() => readFileSync(sentinel));
  assert.throws(() => execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'command=']));
  assert.equal(readProcessStartTime(process.ppid), expectedStart);
  const child = spawn(
    process.execPath,
    ['-e', 'console.log("ready"); setInterval(() => {}, 1000)', '--', 'space and "quotes"', ''],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const exited = once(child, 'exit');
  await once(child.stdout, 'data');
  try {
    const marker = { pid: child.pid, startTime: readProcessStartTime(child.pid) };
    assert(marker.startTime);
    assert.match(readProcessCommand(child.pid), /space and "quotes"/);
    assert.equal(isProcessZombie(child.pid), false);
    assert.equal(classifyOwnerLiveness({ owner: marker }), 'live');
    assert.equal(
      classifyOwnerLiveness({ owner: { ...marker, startTime: 'different' } }),
      'owner-process-reused',
    );
    const observations = readHostProcessIdentityObservations([child.pid]);
    assert.equal(observations.get(child.pid)?.startTime, marker.startTime);
    assert((await listHostProcesses({ timeoutMs: 5000 })).some((entry) => entry.pid === child.pid));
    child.kill();
    await exited;
    assert.equal(classifyOwnerLiveness({ owner: marker }), 'owner-process-dead');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited;
    }
  }
  const emptyArgv = spawn('/bin/sleep', ['30'], {
    argv0: '',
    env: { TEST_PROCESS_SENTINEL: 'synthetic-not-an-argument' },
    stdio: 'ignore',
  });
  const emptyExit = once(emptyArgv, 'exit');
  await once(emptyArgv, 'spawn');
  try {
    assert.deepEqual(readMacosProcesses([emptyArgv.pid]), []);
    assert.equal(readProcessCommand(emptyArgv.pid), null);
    assert(
      !(await listHostProcesses({ timeoutMs: 5000 })).some((entry) => entry.pid === emptyArgv.pid),
    );
  } finally {
    emptyArgv.kill();
    await emptyExit;
  }
  const holder = spawn(checker, ['zombie'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const holderExit = once(holder, 'exit');
  const lines = createInterface({ input: holder.stdout });
  try {
    const [line] = await once(lines, 'line');
    const pid = Number(line);
    for (let attempt = 0; attempt < 100 && !isProcessZombie(pid); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(isProcessZombie(pid), true);
    assert.equal(
      classifyOwnerLiveness({ owner: { pid, startTime: readProcessStartTime(pid) } }),
      'owner-process-dead',
    );
  } finally {
    holder.stdin.end('\n');
    await holderExit;
    lines.close();
  }
}
console.log(`sandbox process ${mode} passed`);
