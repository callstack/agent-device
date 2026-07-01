import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { symbolicateCrashArtifact } from '../debug-symbols.ts';
import { AppError } from '../../../../kernel/errors.ts';
import { withCommandExecutorOverride } from '../../../../utils/exec.ts';

const UUID = 'ABCDEFAB-CDEF-ABCD-EFAB-CDEFABCDEFAB';
const NORMALIZED_UUID = 'ABCDEFABCDEFABCDEFABCDEFABCDEFAB';
const OTHER_UUID = '11111111-2222-3333-4444-555555555555';

test('symbolicates Apple text crash frames with a matching dSYM UUID', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-debug-symbols-'));
  const artifact = path.join(dir, 'crash.log');
  const out = path.join(dir, 'crash-symbolicated.log');
  const dsym = path.join(dir, 'Demo.app.dSYM');
  await fs.mkdir(dsym);
  await fs.writeFile(
    artifact,
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
      `0x200000000 - 0x20000ffff +Other arm64 <${OTHER_UUID}> /tmp/Other.framework/Other`,
      '',
    ].join('\n'),
  );
  const calls: string[] = [];

  const result = await withCommandExecutorOverride(
    (cmd, args) => {
      calls.push(`${path.basename(cmd)} ${args.join(' ')}`);
      if (cmd === 'xcrun' && args.join(' ') === '--find dwarfdump') {
        return Promise.resolve({ stdout: '/tools/dwarfdump\n', stderr: '', exitCode: 0 });
      }
      if (cmd === 'xcrun' && args.join(' ') === '--find atos') {
        return Promise.resolve({ stdout: '/tools/atos\n', stderr: '', exitCode: 0 });
      }
      if (cmd === '/tools/dwarfdump') {
        return Promise.resolve({
          stdout: `UUID: ${UUID} (arm64) ${dsym}/Contents/Resources/DWARF/Demo\n`,
          stderr: '',
          exitCode: 0,
        });
      }
      if (cmd === '/tools/atos') {
        assert.deepEqual(args, [
          '-arch',
          'arm64',
          '-o',
          `${dsym}/Contents/Resources/DWARF/Demo`,
          '-l',
          '0x100000000',
          '0x100001000',
        ]);
        return Promise.resolve({ stdout: 'main + 12\n', stderr: '', exitCode: 0 });
      }
      return undefined;
    },
    async () => await symbolicateCrashArtifact({ artifact, dsym, out }),
  );

  const output = await fs.readFile(out, 'utf8');
  assert.match(output, /0\s+Demo\s+0x0000000100001000.*\/\/ main \+ 12/);
  assert.equal(result.outPath, out);
  assert.equal(result.symbolicatedFrames, 1);
  assert.equal(result.skippedImages, 1);
  assert.equal(result.crash.appName, 'Demo');
  assert.equal(result.crash.bundleId, 'com.example.Demo');
  assert.equal(result.crash.crashedThread, 0);
  assert.equal(result.crash.topFrames[0]?.symbol, 'main + 12');
  assert.match(result.crash.findings[0] ?? '', /Start with main \+ 12/);
  assert.deepEqual(result.matchedImages[0], {
    name: 'Demo',
    uuid: NORMALIZED_UUID,
    arch: 'arm64',
    dsymPath: dsym,
    binaryPath: `${dsym}/Contents/Resources/DWARF/Demo`,
  });
  assert.ok(calls.some((call) => call.includes('dwarfdump --uuid')));
});

test('matches dSYMs discovered under search path and symbolicates IPS frames', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-debug-ips-'));
  const artifact = path.join(dir, 'crash.ips');
  const buildDir = path.join(dir, 'build');
  const dsym = path.join(buildDir, 'Products', 'Demo.app.dSYM');
  const out = path.join(dir, 'crash-symbolicated.ips');
  await fs.mkdir(dsym, { recursive: true });
  await fs.writeFile(
    artifact,
    JSON.stringify({
      usedImages: [{ name: 'Demo', uuid: UUID, arch: 'arm64', base: 4_294_967_296 }],
      threads: [{ frames: [{ imageIndex: 0, imageOffset: 8192 }] }],
    }),
  );

  const result = await withCommandExecutorOverride(
    (cmd, args) => {
      if (cmd === 'xcrun' && args[1] === 'dwarfdump') {
        return Promise.resolve({ stdout: '/tools/dwarfdump\n', stderr: '', exitCode: 0 });
      }
      if (cmd === 'xcrun' && args[1] === 'atos') {
        return Promise.resolve({ stdout: '/tools/atos\n', stderr: '', exitCode: 0 });
      }
      if (cmd === '/tools/dwarfdump') {
        return Promise.resolve({
          stdout: `UUID: ${UUID} (arm64) ${dsym}/Contents/Resources/DWARF/Demo\n`,
          stderr: '',
          exitCode: 0,
        });
      }
      if (cmd === '/tools/atos') {
        assert.equal(args.at(-1), '0x100002000');
        return Promise.resolve({
          stdout: 'ViewController.crash() + 44\n',
          stderr: '',
          exitCode: 0,
        });
      }
      return undefined;
    },
    async () => await symbolicateCrashArtifact({ artifact, searchPath: buildDir, out }),
  );

  const output = JSON.parse(await fs.readFile(out, 'utf8')) as any;
  assert.equal(output.threads[0].frames[0].symbol, 'ViewController.crash()');
  assert.equal(output.threads[0].frames[0].symbolLocation, 44);
  assert.equal(output.agentDeviceSymbolication.symbolicatedFrames, 1);
  assert.equal(result.matchedImages[0]?.dsymPath, dsym);
});

test('preserves modern two-document IPS headers while symbolicating payload frames', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-debug-ips-header-'));
  const artifact = path.join(dir, 'crash.ips');
  const dsym = path.join(dir, 'Demo.app.dSYM');
  const out = path.join(dir, 'crash-symbolicated.ips');
  const header = '{"app_name":"Demo","timestamp":"2026-06-11 12:00:00.00 +0200"}';
  await fs.mkdir(dsym);
  await fs.writeFile(
    artifact,
    `${header}\n${JSON.stringify({
      procName: 'Demo',
      bundleInfo: { CFBundleIdentifier: 'com.example.Demo' },
      exception: { type: 'EXC_CRASH', codes: '0x0000000000000000, 0x0000000000000000' },
      faultingThread: 0,
      usedImages: [{ name: 'Demo', uuid: UUID, arch: 'arm64', base: '0x100000000' }],
      threads: [{ frames: [{ imageIndex: 0, imageOffset: '0x2000' }] }],
    })}`,
  );

  const result = await withCommandExecutorOverride(
    (cmd, args) => {
      if (cmd === 'xcrun') {
        return Promise.resolve({ stdout: `/tools/${args.at(-1)}\n`, stderr: '', exitCode: 0 });
      }
      if (cmd === '/tools/dwarfdump') {
        return Promise.resolve({
          stdout: `UUID: ${UUID} (arm64) ${dsym}/Contents/Resources/DWARF/Demo\n`,
          stderr: '',
          exitCode: 0,
        });
      }
      if (cmd === '/tools/atos') {
        assert.equal(args.at(-1), '0x100002000');
        return Promise.resolve({
          stdout: 'ViewController.crash() + 44\n',
          stderr: '',
          exitCode: 0,
        });
      }
      return undefined;
    },
    async () => await symbolicateCrashArtifact({ artifact, dsym, out }),
  );

  const output = await fs.readFile(out, 'utf8');
  const newlineIndex = output.indexOf('\n');
  assert.equal(output.slice(0, newlineIndex), header);
  const payload = JSON.parse(output.slice(newlineIndex + 1));
  assert.equal(payload.threads[0].frames[0].symbol, 'ViewController.crash()');
  assert.equal(payload.agentDeviceSymbolication.symbolicatedFrames, 1);
  assert.equal(result.crash.appName, 'Demo');
  assert.equal(result.crash.bundleId, 'com.example.Demo');
  assert.equal(result.crash.exceptionType, 'EXC_CRASH');
  assert.equal(result.crash.topFrames[0]?.symbol, 'ViewController.crash() + 44');
});

test('reports a UUID mismatch with actionable details', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-debug-mismatch-'));
  const artifact = path.join(dir, 'crash.log');
  const dsym = path.join(dir, 'Demo.app.dSYM');
  await fs.mkdir(dsym);
  await fs.writeFile(
    artifact,
    [
      'Binary Images:',
      ...Array.from(
        { length: 8 },
        (_value, index) =>
          `0x${(0x100000000 + index * 0x100000).toString(16)} - 0x${(
            0x10000ffff +
            index * 0x100000
          ).toString(
            16,
          )} +Demo${index} arm64 <${uuidFromIndex(index)}> /tmp/Demo${index}.app/Demo${index}`,
      ),
    ].join('\n'),
  );

  const error = await readRejectedError(
    withCommandExecutorOverride(
      (cmd, args) => {
        if (cmd === 'xcrun') {
          return Promise.resolve({ stdout: `/tools/${args.at(-1)}\n`, stderr: '', exitCode: 0 });
        }
        if (cmd === '/tools/dwarfdump') {
          return Promise.resolve({
            stdout: Array.from(
              { length: 7 },
              (_value, index) =>
                `UUID: ${uuidFromIndex(index + 20)} (arm64) ${dsym}/Contents/Resources/DWARF/Demo${index}\n`,
            ).join(''),
            stderr: '',
            exitCode: 0,
          });
        }
        return undefined;
      },
      async () => await symbolicateCrashArtifact({ artifact, dsym }),
    ),
  );

  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'COMMAND_FAILED');
  assert.match(error.message, /dSYM UUID does not match/);
  assert.equal(error.details?.artifactUuidCount, 8);
  assert.equal(error.details?.dsymUuidCount, 7);
  assert.ok(Array.isArray(error.details?.artifactUuidSample));
  assert.equal(error.details.artifactUuidSample.length, 5);
  assert.ok(Array.isArray(error.details?.dsymUuidSample));
  assert.equal(error.details.dsymUuidSample.length, 5);
  assert.equal(Object.hasOwn(error.details, 'artifactUuids'), false);
  assert.equal(Object.hasOwn(error.details, 'dsymUuids'), false);
  assert.equal(typeof error.details?.hint, 'string');
});

test('normalizes malformed IPS numeric fields into AppErrors', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-debug-invalid-ips-'));
  const artifact = path.join(dir, 'crash.ips');
  const dsym = path.join(dir, 'Demo.app.dSYM');
  await fs.mkdir(dsym);
  await fs.writeFile(
    artifact,
    JSON.stringify({
      usedImages: [{ name: 'Demo', uuid: UUID, arch: 'arm64', base: 4_294_967_296 }],
      threads: [{ frames: [{ imageIndex: 0, imageOffset: 1.5 }] }],
    }),
  );

  const error = await readRejectedError(symbolicateCrashArtifact({ artifact, dsym }));

  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'INVALID_ARGS');
  assert.match(error.message, /Invalid IPS frame numeric field: imageOffset/);
  assert.equal(typeof error.details?.hint, 'string');
});

test('normalizes malformed IPS image bases into AppErrors', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-debug-invalid-base-'));
  const artifact = path.join(dir, 'crash.ips');
  const dsym = path.join(dir, 'Demo.app.dSYM');
  await fs.mkdir(dsym);
  await fs.writeFile(
    artifact,
    JSON.stringify({
      usedImages: [{ name: 'Demo', uuid: UUID, arch: 'arm64', base: 4_294_967_296.5 }],
      threads: [{ frames: [{ imageIndex: 0, imageOffset: 4096 }] }],
    }),
  );

  const error = await readRejectedError(symbolicateCrashArtifact({ artifact, dsym }));

  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'INVALID_ARGS');
  assert.match(error.message, /Invalid IPS usedImages numeric field: base/);
  assert.equal(typeof error.details?.hint, 'string');
});

test('rejects nonexistent search paths with an actionable invalid-args hint', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-debug-missing-search-'));
  const artifact = path.join(dir, 'crash.log');
  const searchPath = path.join(dir, 'missing-build');
  await fs.writeFile(
    artifact,
    ['Binary Images:', `0x100000000 - 0x10000ffff +Demo arm64 <${UUID}> /tmp/Demo.app/Demo`].join(
      '\n',
    ),
  );

  const error = await readRejectedError(symbolicateCrashArtifact({ artifact, searchPath }));

  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'INVALID_ARGS');
  assert.match(error.message, /search path does not exist/);
  assert.equal(typeof error.details?.hint, 'string');
});

test('rejects oversized crash artifacts before loading them into memory', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-debug-large-artifact-'));
  const artifact = path.join(dir, 'crash.log');
  const dsym = path.join(dir, 'Demo.app.dSYM');
  await fs.mkdir(dsym);
  await fs.writeFile(artifact, '');
  await fs.truncate(artifact, 64 * 1024 * 1024 + 1);

  const error = await readRejectedError(symbolicateCrashArtifact({ artifact, dsym }));

  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'INVALID_ARGS');
  assert.match(error.message, /crash artifact is too large/);
  assert.equal(error.details?.maxBytes, 64 * 1024 * 1024);
  assert.equal(error.details?.actualBytes, 64 * 1024 * 1024 + 1);
  assert.match(String(error.details?.hint), /bounded Apple/);
});

test('uses address ranges for duplicate text crash image names and supports arm64_32', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-debug-duplicate-images-'));
  const artifact = path.join(dir, 'crash.log');
  const dsym = path.join(dir, 'Demo.app.dSYM');
  await fs.mkdir(dsym);
  await fs.writeFile(
    artifact,
    [
      'Thread 0 Crashed:',
      '0   Demo  0x0000000200001000 0x200000000 + 4096',
      '',
      'Binary Images:',
      `0x100000000 - 0x10000ffff +Demo arm64 <${OTHER_UUID}> /tmp/First/Demo.app/Demo`,
      `0x200000000 - 0x20000ffff +Demo arm64_32 <${UUID}> /tmp/Second/Demo.app/Demo`,
      `0x300000000 - 0x30000ffff  Demo (1.0 - 1) <${uuidFromIndex(
        30,
      )}> /Applications/Demo.app/Contents/MacOS/Demo`,
      '',
    ].join('\n'),
  );

  const result = await withCommandExecutorOverride(
    (cmd, args) => {
      if (cmd === 'xcrun') {
        return Promise.resolve({ stdout: `/tools/${args.at(-1)}\n`, stderr: '', exitCode: 0 });
      }
      if (cmd === '/tools/dwarfdump') {
        return Promise.resolve({
          stdout: `UUID: ${UUID} (arm64_32) ${dsym}/Contents/Resources/DWARF/Demo\n`,
          stderr: '',
          exitCode: 0,
        });
      }
      if (cmd === '/tools/atos') {
        assert.deepEqual(args, [
          '-arch',
          'arm64_32',
          '-o',
          `${dsym}/Contents/Resources/DWARF/Demo`,
          '-l',
          '0x200000000',
          '0x200001000',
        ]);
        return Promise.resolve({ stdout: 'selectedDuplicateImage + 4\n', stderr: '', exitCode: 0 });
      }
      return undefined;
    },
    async () => await symbolicateCrashArtifact({ artifact, dsym }),
  );

  assert.equal(result.symbolicatedFrames, 1);
  assert.equal(result.matchedImages[0]?.uuid, NORMALIZED_UUID);
  assert.equal(result.matchedImages[0]?.arch, 'arm64_32');
});

test('keeps atos output aligned and ignores unsymbolicated address echoes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-debug-atos-align-'));
  const artifact = path.join(dir, 'crash.log');
  const out = path.join(dir, 'crash-symbolicated.log');
  const dsym = path.join(dir, 'Demo.app.dSYM');
  await fs.mkdir(dsym);
  await fs.writeFile(
    artifact,
    [
      'Thread 0 Crashed:',
      '0   Demo  0x0000000100001000 0x100000000 + 4096',
      '1   Demo  0x0000000100002000 0x100000000 + 8192',
      '',
      'Binary Images:',
      `0x100000000 - 0x10000ffff +Demo arm64 <${UUID}> /tmp/Demo.app/Demo`,
      '',
    ].join('\n'),
  );

  const result = await withCommandExecutorOverride(
    (cmd, args) => {
      if (cmd === 'xcrun') {
        return Promise.resolve({ stdout: `/tools/${args.at(-1)}\n`, stderr: '', exitCode: 0 });
      }
      if (cmd === '/tools/dwarfdump') {
        return Promise.resolve({
          stdout: `UUID: ${UUID} (arm64) ${dsym}/Contents/Resources/DWARF/Demo\n`,
          stderr: '',
          exitCode: 0,
        });
      }
      if (cmd === '/tools/atos') {
        return Promise.resolve({
          stdout: '0x100001000\nsecondSymbol + 8\n',
          stderr: '',
          exitCode: 0,
        });
      }
      return undefined;
    },
    async () => await symbolicateCrashArtifact({ artifact, dsym, out }),
  );

  const output = await fs.readFile(out, 'utf8');
  assert.equal(result.symbolicatedFrames, 1);
  assert.doesNotMatch(output, /0\s+Demo.*\/\//);
  assert.match(output, /1\s+Demo\s+0x0000000100002000.*\/\/ secondSymbol \+ 8/);
});

test('reports missing Apple tools before attempting symbolication', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-debug-tool-'));
  const artifact = path.join(dir, 'crash.log');
  const dsym = path.join(dir, 'Demo.app.dSYM');
  await fs.mkdir(dsym);
  await fs.writeFile(
    artifact,
    ['Binary Images:', `0x100000000 - 0x10000ffff +Demo arm64 <${UUID}> /tmp/Demo.app/Demo`].join(
      '\n',
    ),
  );

  const error = await readRejectedError(
    withCommandExecutorOverride(
      (cmd) => {
        if (cmd === 'xcrun') {
          return Promise.resolve({ stdout: '', stderr: 'missing', exitCode: 1 });
        }
        return undefined;
      },
      async () => await symbolicateCrashArtifact({ artifact, dsym }),
    ),
  );

  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'TOOL_MISSING');
  assert.match(error.message, /dwarfdump/);
  assert.equal(typeof error.details?.hint, 'string');
});

test('defers Android crash symbolication with a clear hint', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-debug-android-'));
  const artifact = path.join(dir, 'android-crash.log');
  await fs.writeFile(
    artifact,
    [
      'java.lang.RuntimeException: boom',
      '  at com.example.MainActivity.onCreate(MainActivity.kt:10)',
    ].join('\n'),
  );

  const error = await readRejectedError(
    symbolicateCrashArtifact({ artifact, dsym: path.join(dir, 'mapping.txt') }),
  );

  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'UNSUPPORTED_OPERATION');
  assert.match(String(error.details?.hint), /Android Java\/R8/);
});

async function readRejectedError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected promise to reject.');
}

function uuidFromIndex(index: number): string {
  return `${index.toString(16).padStart(8, '0')}-aaaa-bbbb-cccc-${index
    .toString(16)
    .padStart(12, '0')}`;
}
