import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'vitest';
import { withCommandExecutorOverride } from '@agent-device/host-kit/command';
import { runCliCapture } from './cli-capture.ts';
import { mkdtempForTest } from './test-utils/tmp-dir.ts';

const UUID = 'ABCDEFAB-CDEF-ABCD-EFAB-CDEFABCDEFAB';

test('debug symbols prints only compact human output and does not contact daemon', async () => {
  const fixture = await makeCrashFixture('human');
  const result = await withFakeAppleTools(
    fixture,
    async () =>
      await runCliCapture(
        [
          'debug',
          'symbols',
          '--artifact',
          'crash.log',
          '--dsym',
          'Demo.app.dSYM',
          '--out',
          'crash-symbolicated.log',
        ],
        { cwd: fixture.dir },
      ),
  );

  assert.equal(result.code, null);
  assert.equal(result.calls.length, 0);
  assert.match(result.stdout, /crash-symbolicated\.log/);
  assert.match(result.stdout, /Symbolicated 1 frame/);
  assert.match(result.stdout, /Crash: Demo thread 0/);
  assert.match(result.stdout, /Exception: EXC_CRASH/);
  assert.match(result.stdout, /Finding: Start with main \+ 12 in Demo/);
  assert.doesNotMatch(result.stdout, /Thread 0 Crashed/);
  assert.match(await fs.readFile(fixture.out, 'utf8'), /main \+ 12/);
});

test('debug symbols JSON output returns artifact paths and summary', async () => {
  const fixture = await makeCrashFixture('json');
  const result = await withFakeAppleTools(
    fixture,
    async () =>
      await runCliCapture(
        [
          'debug',
          'symbols',
          '--artifact',
          'crash.log',
          '--dsym',
          'Demo.app.dSYM',
          '--out',
          'crash-symbolicated.log',
          '--json',
        ],
        { cwd: fixture.dir },
      ),
  );

  assert.equal(result.code, null);
  assert.equal(result.calls.length, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.success, true);
  assert.equal(payload.data.outPath, await fs.realpath(fixture.out));
  assert.equal(payload.data.symbolicatedFrames, 1);
  assert.equal(payload.data.matchedImages[0].name, 'Demo');
  assert.equal(payload.data.crash.appName, 'Demo');
  assert.equal(payload.data.crash.exceptionType, 'EXC_CRASH (SIGABRT)');
  assert.equal(payload.data.crash.topFrames[0].symbol, 'main + 12');
  assert.doesNotMatch(result.stdout, /Thread 0 Crashed/);
});

test('debug rejects catch-all diagnostics subcommands', async () => {
  const result = await runCliCapture(['debug', 'perf']);

  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 0);
  assert.match(result.stderr, /debug supports only symbols/);
  assert.match(result.stderr, /use logs, network, perf, record, trace, or react-devtools/);
});

async function makeCrashFixture(label: string): Promise<{
  dir: string;
  dsym: string;
  out: string;
}> {
  const dir = await mkdtempForTest(`agent-device-cli-debug-${label}-`);
  const dsym = path.join(dir, 'Demo.app.dSYM');
  const out = path.join(dir, 'crash-symbolicated.log');
  await fs.mkdir(dsym);
  await fs.writeFile(
    path.join(dir, 'crash.log'),
    [
      'Process:               Demo [123]',
      'Identifier:            com.example.Demo',
      'Exception Type:        EXC_CRASH (SIGABRT)',
      'Triggered by Thread:   0',
      '',
      'Thread 0 Crashed:',
      '0   Demo  0x0000000100001000 0x100000000 + 4096',
      '',
      'Binary Images:',
      `0x100000000 - 0x10000ffff +Demo arm64 <${UUID}> /tmp/Demo.app/Demo`,
      '',
    ].join('\n'),
  );
  return { dir, dsym, out };
}

async function withFakeAppleTools<T>(fixture: { dsym: string }, fn: () => Promise<T>): Promise<T> {
  return await withCommandExecutorOverride((cmd, args) => {
    if (cmd === 'xcrun') {
      return Promise.resolve({ stdout: `/tools/${args.at(-1)}\n`, stderr: '', exitCode: 0 });
    }
    if (cmd === '/tools/dwarfdump') {
      return Promise.resolve({
        stdout: `UUID: ${UUID} (arm64) ${fixture.dsym}/Contents/Resources/DWARF/Demo\n`,
        stderr: '',
        exitCode: 0,
      });
    }
    if (cmd === '/tools/atos') {
      return Promise.resolve({ stdout: 'main + 12\n', stderr: '', exitCode: 0 });
    }
    return undefined;
  }, fn);
}
