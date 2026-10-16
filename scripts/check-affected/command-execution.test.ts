import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { runCmdBackground } from '@agent-device/host-kit/command';
import { entry, fixture, run } from './execution.fixtures.ts';
import type { ExecutionReceipt } from './execution.ts';

test(
  'SIGTERM cancels the command group, records cancellation, and releases the host lock',
  { skip: process.platform === 'win32' },
  async () => {
    const { cwd } = fixture();
    const ready = path.join(cwd, '.tmp', 'ready.json');
    const source = `
    import { runValidation } from ${JSON.stringify(entry)};
    const code = await runValidation(${JSON.stringify(cwd)}, { base: 'HEAD', head: 'HEAD', json: true }, async ({execute}) => {
      return execute([process.execPath, '-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(ready)}, JSON.stringify(process.pid)); setInterval(() => {}, 1000);`)}], ${JSON.stringify(cwd)}, 'sleep');
    }); process.exitCode = code;
  `;
    const { child, wait } = runCmdBackground(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', source],
      {
        cwd,
        allowFailure: true,
        env: { ...process.env, HOME: cwd, USERPROFILE: cwd, AGENT_DEVICE_VALIDATION_PARENT: '' },
      },
    );
    try {
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(ready) && Date.now() < deadline) await setTimeout(20);
      assert.ok(fs.existsSync(ready), 'command must actually start');
      const commandPid = JSON.parse(fs.readFileSync(ready, 'utf8')) as number;
      child.kill('SIGTERM');
      const result = await wait;
      assert.equal(result.exitCode, 143, result.stderr);
      const receipt = JSON.parse(result.stdout) as ExecutionReceipt;
      assert.equal(receipt.status, 'cancelled');
      assert.equal(receipt.results[0]?.status, 'cancelled');
      assert.throws(() => process.kill(commandPid, 0), { code: 'ESRCH' });
      assert.equal(run(cwd, 'HEAD', 'return 0;').exitCode, 0);
    } finally {
      child.kill('SIGKILL');
      await wait;
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  },
);

test(
  'a killed validation parent does not let a waiter overlap its surviving command group',
  { skip: process.platform === 'win32' },
  async () => {
    const { cwd } = fixture();
    const ready = path.join(cwd, '.tmp', 'orphan.json');
    const env = { ...process.env, HOME: cwd, USERPROFILE: cwd, AGENT_DEVICE_VALIDATION_PARENT: '' };
    const source = `
    import { runValidation } from ${JSON.stringify(entry)};
    const code = await runValidation(${JSON.stringify(cwd)}, { base: 'HEAD', head: 'HEAD', json: true }, async ({execute}) => execute([process.execPath, '-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(ready)}, JSON.stringify(process.pid)); setInterval(() => {}, 1000);`)}], ${JSON.stringify(cwd)}, 'orphan'));
    process.exitCode = code;
  `;
    const parent = runCmdBackground(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', source],
      { cwd, env, allowFailure: true },
    );
    let commandPid: number | undefined;
    let waiter: ReturnType<typeof runCmdBackground> | undefined;
    try {
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(ready) && Date.now() < deadline) await setTimeout(20);
      assert.ok(fs.existsSync(ready));
      commandPid = (
        JSON.parse(
          fs.readFileSync(
            path.join(cwd, '.cache', 'agent-device', 'validation.lock.active.json'),
            'utf8',
          ),
        ) as { pid: number }
      ).pid;
      parent.child.kill('SIGKILL');
      await parent.wait;
      waiter = runCmdBackground(
        process.execPath,
        [
          '--experimental-strip-types',
          '--input-type=module',
          '-e',
          `
      import { runValidation } from ${JSON.stringify(entry)};
      process.exitCode = await runValidation(${JSON.stringify(cwd)}, {base:'HEAD',head:'HEAD',json:true}, async () => 0);
    `,
        ],
        { cwd, env, allowFailure: true },
      );
      let observedWait = false;
      waiter.child.stderr?.on('data', (data) => {
        if (String(data).includes('[wait] orphan')) observedWait = true;
      });
      const waitDeadline = Date.now() + 5000;
      while (!observedWait && Date.now() < waitDeadline) await setTimeout(20);
      assert.equal(observedWait, true, 'waiter must observe surviving command before acquiring');
      process.kill(-commandPid, 'SIGTERM');
      const result = await waiter.wait;
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).status, 'passed');
    } finally {
      parent.child.kill('SIGKILL');
      waiter?.child.kill('SIGTERM');
      if (commandPid) {
        try {
          process.kill(-commandPid, 'SIGKILL');
        } catch {}
      }
      await parent.wait;
      await waiter?.wait;
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  },
);
