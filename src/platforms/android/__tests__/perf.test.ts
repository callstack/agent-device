import assert from 'node:assert/strict';
import fs, { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import type { AndroidAdbExecutor } from '../adb-executor.ts';
import { parseAndroidFramePerfSample } from '../perf-frame-parser.ts';
import {
  captureAndroidHeapSnapshot,
  cleanupAndroidNativePerfSession,
  parseAndroidMemInfoSample,
  startAndroidPerfettoTrace,
  startAndroidSimpleperfProfile,
  stopAndroidPerfettoTrace,
  stopAndroidSimpleperfProfile,
  writeAndroidSimpleperfReport,
  type AndroidNativePerfSession,
} from '../perf.ts';
import { ANDROID_EMULATOR } from '../../../__tests__/test-utils/index.ts';

test('parseAndroidMemInfoSample supports legacy total row layout', () => {
  const sample = parseAndroidMemInfoSample(
    [
      '** MEMINFO in pid 9953 [com.example.app] **',
      '                 Pss     Pss  Shared Private  Shared Private    Heap    Heap    Heap',
      '               Total   Clean   Dirty   Dirty   Clean   Clean    Size   Alloc    Free',
      '              ------  ------  ------  ------  ------  ------  ------  ------  ------',
      '    Dalvik Heap   5110(3)    0    4136    4988(3)    0       0    9168    8958(6)  210',
      // Legacy dumpsys output may annotate values with "(N)" counters after the numeric token.
      '         TOTAL  24358(1) 4188    9724   17972(2) 16388    4260(2) 16968   16595     336',
    ].join('\n'),
    'com.example.app',
    '2026-04-01T10:00:00.000Z',
  );

  assert.equal(sample.totalPssKb, 24358);
  assert.equal(sample.totalRssKb, undefined);
});

test('parseAndroidMemInfoSample returns bounded top memory consumers', () => {
  const sample = parseAndroidMemInfoSample(
    [
      '** MEMINFO in pid 9953 [com.example.app] **',
      '                   Pss  Private  Private  Swapped     Heap     Heap     Heap',
      '                 Total    Dirty    Clean    Dirty     Size    Alloc     Free',
      '                ------   ------   ------   ------   ------   ------   ------',
      '      Native Heap  12000    10000        0        0    20000    14000     6000',
      '      Dalvik Heap  32000    20000        0        0    50000    40000    10000',
      '       Other mmap   8000     1000     7000        0',
      '          TOTAL   52000   31000     7000        0    70000    54000    16000',
      'App Summary',
      '  TOTAL PSS:    52,000            TOTAL RSS:   100,112       TOTAL SWAP PSS:        0',
    ].join('\n'),
    'com.example.app',
    '2026-04-01T10:00:00.000Z',
  );

  assert.equal(sample.totalPssKb, 52000);
  assert.deepEqual(sample.topConsumers, [
    { name: 'Dalvik Heap', pssKb: 32000 },
    { name: 'Native Heap', pssKb: 12000 },
    { name: 'Other mmap', pssKb: 8000 },
  ]);
});

test('captureAndroidHeapSnapshot resolves pid, dumps heap, pulls artifact, and cleans remote path', async () => {
  const calls: string[][] = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-android-hprof-test-'));
  const outPath = path.join(tmpDir, 'app.hprof');
  const adb: AndroidAdbExecutor = async (args) => {
    calls.push([...args]);
    if (args.join(' ') === 'shell pidof com.example.app') {
      return { stdout: '4242\n', stderr: '', exitCode: 0 };
    }
    if (args.slice(0, 4).join(' ') === 'shell am dumpheap com.example.app') {
      assert.match(
        args[4] ?? '',
        /^\/data\/local\/tmp\/agent-device-com\.example\.app-\d+\.hprof$/,
      );
      return { stdout: 'Dumping Java heap to ', stderr: '', exitCode: 0 };
    }
    if (args[0] === 'pull') {
      assert.equal(args[2], outPath);
      fs.writeFileSync(outPath, 'hprof-bytes');
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (args.slice(0, 3).join(' ') === 'shell rm -f') {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    throw new Error(`unexpected adb call: ${args.join(' ')}`);
  };

  try {
    const snapshot = await captureAndroidHeapSnapshot(
      ANDROID_EMULATOR,
      'com.example.app',
      outPath,
      { adb },
    );

    assert.equal(snapshot.kind, 'android-hprof');
    assert.equal(snapshot.path, outPath);
    assert.equal(snapshot.sizeBytes, 'hprof-bytes'.length);
    assert.equal(snapshot.pid, 4242);
    assert.equal(calls[0]?.join(' '), 'shell pidof com.example.app');
    assert.equal(calls[1]?.slice(0, 4).join(' '), 'shell am dumpheap com.example.app');
    assert.equal(calls[2]?.[0], 'pull');
    assert.equal(calls.at(-1)?.slice(0, 3).join(' '), 'shell rm -f');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('captureAndroidHeapSnapshot explains missing process failures', async () => {
  const adb: AndroidAdbExecutor = async () => ({ stdout: '', stderr: '', exitCode: 1 });
  await assert.rejects(
    () =>
      captureAndroidHeapSnapshot(ANDROID_EMULATOR, 'com.example.missing', '/tmp/app.hprof', {
        adb,
      }),
    /No running Android process found/,
  );
});

test('captureAndroidHeapSnapshot cleans remote path when dumpheap fails', async () => {
  const calls: string[][] = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-android-hprof-dump-fail-'));
  const outPath = path.join(tmpDir, 'app.hprof');
  const adb: AndroidAdbExecutor = async (args) => {
    calls.push([...args]);
    if (args.join(' ') === 'shell pidof com.example.app') {
      return { stdout: '4242\n', stderr: '', exitCode: 0 };
    }
    if (args.slice(0, 4).join(' ') === 'shell am dumpheap com.example.app') {
      return { stdout: '', stderr: 'Process not debuggable', exitCode: 1 };
    }
    if (args.slice(0, 3).join(' ') === 'shell rm -f') {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    throw new Error(`unexpected adb call: ${args.join(' ')}`);
  };

  try {
    await assert.rejects(
      () => captureAndroidHeapSnapshot(ANDROID_EMULATOR, 'com.example.app', outPath, { adb }),
      /Failed to capture Android heap dump/,
    );
    assert.equal(calls.at(-1)?.slice(0, 3).join(' '), 'shell rm -f');
    assert.equal(fs.existsSync(outPath), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('captureAndroidHeapSnapshot removes partial local artifact when pull fails', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-android-hprof-pull-fail-'));
  const outPath = path.join(tmpDir, 'app.hprof');
  const adb: AndroidAdbExecutor = async (args) => {
    if (args.join(' ') === 'shell pidof com.example.app') {
      return { stdout: '4242\n', stderr: '', exitCode: 0 };
    }
    if (args.slice(0, 4).join(' ') === 'shell am dumpheap com.example.app') {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (args[0] === 'pull') {
      fs.writeFileSync(outPath, 'partial-hprof');
      return { stdout: '', stderr: 'pull failed', exitCode: 1 };
    }
    if (args.slice(0, 3).join(' ') === 'shell rm -f') {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    throw new Error(`unexpected adb call: ${args.join(' ')}`);
  };

  try {
    await assert.rejects(
      () => captureAndroidHeapSnapshot(ANDROID_EMULATOR, 'com.example.app', outPath, { adb }),
      /Failed to pull Android heap dump/,
    );
    assert.equal(fs.existsSync(outPath), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('parseAndroidFramePerfSample summarizes dropped frame percentage from framestats rows', () => {
  const sample = parseAndroidFramePerfSample(
    [
      'Stats since: 123456789ns',
      '---PROFILEDATA---',
      'Flags,IntendedVsync,Vsync,OldestInputEvent,NewestInputEvent,HandleInputStart,AnimationStart,PerformTraversalsStart,DrawStart,SyncQueued,SyncStart,IssueDrawCommandsStart,SwapBuffers,FrameCompleted,DequeueBufferDuration,QueueBufferDuration,GpuCompleted',
      '0,1000000000,1000000000,0,0,0,0,0,0,0,0,0,0,1010000000,0,0,1010000000',
      '0,1016666667,1016666667,0,0,0,0,0,0,0,0,0,0,1034666667,0,0,1034666667',
      '0,1033333334,1033333334,0,0,0,0,0,0,0,0,0,0,1063333334,0,0,1063333334',
      '1,1050000001,1050000001,0,0,0,0,0,0,0,0,0,0,1100000001,0,0,1100000001',
      '0,1066666668,1066666668,0,0,0,0,0,0,0,0,0,0,1082666668,0,0,1082666668',
      '---PROFILEDATA---',
    ].join('\n'),
    'com.example.app',
    '2026-04-01T10:00:00.000Z',
  );

  assert.equal(sample.droppedFrameCount, 2);
  assert.equal(sample.totalFrameCount, 4);
  assert.equal(sample.droppedFramePercent, 50);
  assert.equal(sample.frameDeadlineMs, 16.7);
  assert.equal(sample.refreshRateHz, 60);
  assert.equal(sample.method, 'adb-shell-dumpsys-gfxinfo-framestats');
  assert.equal(sample.source, 'framestats-rows');
  assert.equal(sample.worstWindows?.[0]?.missedDeadlineFrameCount, 2);
});

test('parseAndroidFramePerfSample prefers Android gfxinfo janky frame summary', () => {
  const sample = parseAndroidFramePerfSample(
    [
      'Applications Graphics Acceleration Info:',
      'Uptime: 164892458 Realtime: 164892458',
      '',
      '** Graphics info for pid 16305 [host.exp.exponent] **',
      '',
      'Stats since: 164496032562094ns',
      'Total frames rendered: 4569',
      'Janky frames: 115 (2.52%)',
      'Janky frames (legacy): 3971 (86.91%)',
      'Number Frame deadline missed: 115',
      'Profile data in ms:',
      'Flags,IntendedVsync,FrameCompleted',
      '0,1000000000,1010000000',
    ].join('\n'),
    'host.exp.exponent',
    '2026-04-01T10:00:00.000Z',
  );

  assert.equal(sample.droppedFrameCount, 115);
  assert.equal(sample.totalFrameCount, 4569);
  assert.equal(sample.droppedFramePercent, 2.5);
  assert.equal(sample.source, 'android-gfxinfo-summary');
});

test('parseAndroidFramePerfSample omits frame deadline when rows are too sparse', () => {
  const sample = parseAndroidFramePerfSample(
    [
      'Applications Graphics Acceleration Info:',
      'Uptime: 11000 Realtime: 11000',
      'Stats since: 10000000000ns',
      'Total frames rendered: 3',
      'Janky frames: 1 (33.33%)',
      'Profile data in ms:',
      'Flags,IntendedVsync,FrameCompleted',
      '0,10000000000,10012000000',
      '0,10150000000,10162000000',
      '0,10300000000,10312000000',
    ].join('\n'),
    'com.example.app',
    '2026-04-01T10:00:11.000Z',
  );

  assert.equal(sample.droppedFramePercent, 33.3);
  assert.equal(sample.frameDeadlineMs, undefined);
  assert.equal(sample.refreshRateHz, undefined);
  assert.equal(sample.worstWindows?.[0]?.missedDeadlineFrameCount, 1);
});

test('parseAndroidFramePerfSample caps worst windows to Android summary count', () => {
  const sample = parseAndroidFramePerfSample(
    [
      'Applications Graphics Acceleration Info:',
      'Uptime: 11000 Realtime: 11000',
      'Stats since: 10000000000ns',
      'Total frames rendered: 5',
      'Janky frames: 1 (20.00%)',
      'Profile data in ms:',
      'Flags,IntendedVsync,Vsync,OldestInputEvent,NewestInputEvent,HandleInputStart,AnimationStart,PerformTraversalsStart,DrawStart,SyncQueued,SyncStart,IssueDrawCommandsStart,SwapBuffers,FrameCompleted,DequeueBufferDuration,QueueBufferDuration,GpuCompleted',
      '0,10000000000,10000000000,0,0,0,0,0,0,0,0,0,0,10018000000,0,0,10018000000',
      '0,10016666667,10016666667,0,0,0,0,0,0,0,0,0,0,10036666667,0,0,10036666667',
      '0,10033333334,10033333334,0,0,0,0,0,0,0,0,0,0,10063333334,0,0,10063333334',
    ].join('\n'),
    'com.example.app',
    '2026-04-01T10:00:11.000Z',
  );

  assert.equal(sample.droppedFrameCount, 1);
  assert.equal(sample.worstWindows?.[0]?.missedDeadlineFrameCount, 1);
  assert.equal(sample.worstWindows?.[0]?.worstFrameMs, 30);
});

test('parseAndroidFramePerfSample adds estimated timestamps and worst drop windows', () => {
  const sample = parseAndroidFramePerfSample(
    [
      'Applications Graphics Acceleration Info:',
      'Uptime: 11000 Realtime: 11000',
      '',
      'Stats since: 10000000000ns',
      'Total frames rendered: 5',
      'Janky frames: 2 (40.00%)',
      'Profile data in ms:',
      'Flags,IntendedVsync,Vsync,OldestInputEvent,NewestInputEvent,HandleInputStart,AnimationStart,PerformTraversalsStart,DrawStart,SyncQueued,SyncStart,IssueDrawCommandsStart,SwapBuffers,FrameCompleted,DequeueBufferDuration,QueueBufferDuration,GpuCompleted',
      '0,10000000000,10000000000,0,0,0,0,0,0,0,0,0,0,10010000000,0,0,10010000000',
      '0,10016666667,10016666667,0,0,0,0,0,0,0,0,0,0,10076666667,0,0,10076666667',
      '0,10033333334,10033333334,0,0,0,0,0,0,0,0,0,0,10043333334,0,0,10043333334',
      '0,10050000001,10050000001,0,0,0,0,0,0,0,0,0,0,10120000001,0,0,10120000001',
      '0,10066666668,10066666668,0,0,0,0,0,0,0,0,0,0,10076666668,0,0,10076666668',
    ].join('\n'),
    'com.example.app',
    '2026-04-01T10:00:11.000Z',
  );

  assert.equal(sample.windowStartedAt, '2026-04-01T10:00:10.000Z');
  assert.equal(sample.windowEndedAt, '2026-04-01T10:00:11.000Z');
  assert.equal(sample.timestampSource, 'estimated-from-device-uptime');
  assert.equal(sample.worstWindows?.length, 1);
  assert.equal(sample.worstWindows?.[0]?.startOffsetMs, 17);
  assert.equal(sample.worstWindows?.[0]?.endOffsetMs, 120);
  assert.equal(sample.worstWindows?.[0]?.missedDeadlineFrameCount, 2);
  assert.equal(sample.worstWindows?.[0]?.worstFrameMs, 70);
});

test('parseAndroidFramePerfSample treats a reset idle window as an available zero-frame sample', () => {
  const sample = parseAndroidFramePerfSample(
    [
      'Applications Graphics Acceleration Info:',
      'Uptime: 165130629 Realtime: 165130629',
      'Stats since: 165111622765012ns',
      'Total frames rendered: 0',
      'Janky frames: 0 (0.00%)',
      'Number Frame deadline missed: 0',
    ].join('\n'),
    'host.exp.exponent',
    '2026-04-01T10:00:00.000Z',
  );

  assert.equal(sample.droppedFrameCount, 0);
  assert.equal(sample.totalFrameCount, 0);
  assert.equal(sample.droppedFramePercent, 0);
  assert.equal(sample.source, 'android-gfxinfo-summary');
});

test('startAndroidSimpleperfProfile resolves pid and starts a bounded simpleperf recorder', async () => {
  const calls: string[][] = [];
  const adb: AndroidAdbExecutor = async (args) => {
    calls.push(args);
    if (args.join('\0') === ['shell', 'pidof', 'com.example.app'].join('\0')) {
      return { exitCode: 0, stdout: '1234\n', stderr: '' };
    }
    if (args[0] === 'shell' && args[1]?.includes('command -v simpleperf')) {
      return { exitCode: 0, stdout: '/system/bin/simpleperf\n', stderr: '' };
    }
    if (args[0] === 'shell' && args[1]?.includes('simpleperf')) {
      return { exitCode: 0, stdout: '5678\n', stderr: '' };
    }
    throw new Error(`Unexpected adb call: ${args.join(' ')}`);
  };

  const result = await startAndroidSimpleperfProfile(
    ANDROID_EMULATOR,
    'com.example.app',
    '/tmp/cpu.perf.data',
    { adb },
  );

  assert.equal(result.kind, 'simpleperf');
  assert.equal(result.type, 'cpu-profile');
  assert.equal(result.appPid, '1234');
  assert.equal(result.profilerPid, '5678');
  assert.match(calls[2]?.[1] ?? '', /simpleperf.+record.+-p.+1234/);
});

test('stopAndroidSimpleperfProfile pulls the profile artifact and reports compact metadata', async () => {
  const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'agent-device-simpleperf-test-'));
  const outPath = path.join(tmpDir, 'cpu.perf.data');
  const calls: string[][] = [];
  const session: AndroidNativePerfSession = {
    type: 'cpu-profile',
    kind: 'simpleperf',
    packageName: 'com.example.app',
    appPid: '1234',
    profilerPid: '5678',
    remotePath: '/data/local/tmp/cpu.perf.data',
    outPath,
    startedAt: Date.now() - 2000,
    state: 'running',
  };
  const adb: AndroidAdbExecutor = async (args) => {
    calls.push(args);
    if (args[0] === 'shell' && args[1]?.includes('kill -INT')) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'shell' && args[1]?.includes('stat -c %s')) {
      return { exitCode: 0, stdout: '7\n', stderr: '' };
    }
    if (args[0] === 'pull') {
      await fsPromises.writeFile(args[2]!, 'profile');
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'shell' && args[1]?.includes('rm -f')) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    throw new Error(`Unexpected adb call: ${args.join(' ')}`);
  };

  const result = await stopAndroidSimpleperfProfile(ANDROID_EMULATOR, session, outPath, { adb });

  assert.equal(result.state, 'stopped');
  assert.equal(result.artifact.path, outPath);
  assert.equal(result.artifact.sizeBytes, 7);
  assert.ok(findCallIndex(calls, 'stat -c %s') < findCallIndex(calls, 'pull'));
  assert.ok(findCallIndex(calls, 'rm -f') > findCallIndex(calls, 'pull'));
});

test('stopAndroidSimpleperfProfile fails before pull when remote artifact never stabilizes', async () => {
  const tmpDir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'agent-device-simpleperf-missing-test-'),
  );
  const session: AndroidNativePerfSession = {
    type: 'cpu-profile',
    kind: 'simpleperf',
    packageName: 'com.example.app',
    appPid: '1234',
    profilerPid: '5678',
    remotePath: '/data/local/tmp/cpu.perf.data',
    outPath: path.join(tmpDir, 'cpu.perf.data'),
    startedAt: Date.now() - 2000,
    state: 'running',
  };
  const calls: string[][] = [];
  const adb: AndroidAdbExecutor = async (args) => {
    calls.push(args);
    if (args[0] === 'shell' && args[1]?.includes('kill -INT')) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'shell' && args[1]?.includes('stat -c %s')) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    throw new Error(`Unexpected adb call: ${args.join(' ')}`);
  };

  await assert.rejects(
    stopAndroidSimpleperfProfile(ANDROID_EMULATOR, session, session.outPath, { adb }),
    /artifact is not ready/,
  );
  assert.equal(
    calls.some((args) => args[0] === 'pull'),
    false,
  );
});

test('cleanupAndroidNativePerfSession stops profiler and removes remote artifact without pulling', async () => {
  const session: AndroidNativePerfSession = {
    type: 'trace',
    kind: 'perfetto',
    packageName: 'com.example.app',
    appPid: '1234',
    profilerPid: '8765',
    remotePath: '/data/misc/perfetto-traces/app.perfetto-trace',
    outPath: '/tmp/app.perfetto-trace',
    startedAt: Date.now() - 1000,
    state: 'running',
  };
  const calls: string[][] = [];
  const adb: AndroidAdbExecutor = async (args) => {
    calls.push(args);
    if (args[0] === 'shell' && args[1]?.includes('kill -INT')) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'shell' && args[1]?.includes('stat -c %s')) {
      return { exitCode: 0, stdout: '5\n', stderr: '' };
    }
    if (args[0] === 'shell' && args[1]?.includes('rm -f')) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'pull') {
      throw new Error('cleanup must not pull artifacts');
    }
    throw new Error(`Unexpected adb call: ${args.join(' ')}`);
  };

  await cleanupAndroidNativePerfSession(ANDROID_EMULATOR, session, { adb });

  assert.ok(findCallIndex(calls, 'kill -INT') < findCallIndex(calls, 'stat -c %s'));
  assert.ok(findCallIndex(calls, 'rm -f') > findCallIndex(calls, 'stat -c %s'));
  assert.equal(
    calls.some((args) => args[0] === 'pull'),
    false,
  );
});

test('start and stop Android Perfetto trace use perfetto trace storage and cleanup remote artifact', async () => {
  const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'agent-device-perfetto-test-'));
  const outPath = path.join(tmpDir, 'app.perfetto-trace');
  const calls: string[][] = [];
  const adb = makePerfettoTraceAdbExecutor(outPath, calls);

  const started = await startAndroidPerfettoTrace(ANDROID_EMULATOR, 'com.example.app', outPath, {
    adb,
  });
  const stopped = await stopAndroidPerfettoTrace(ANDROID_EMULATOR, started, outPath, { adb });

  assert.equal(started.kind, 'perfetto');
  assert.equal(started.type, 'trace');
  assert.match(started.remotePath, /^\/data\/misc\/perfetto-traces\//);
  assert.equal(stopped.artifact.path, outPath);
  assert.equal(stopped.artifact.sizeBytes, 5);
  assert.deepEqual(stopped.summary.frameHealth, {
    available: true,
    droppedFramePercent: 20,
    droppedFrameCount: 2,
    totalFrameCount: 10,
    method: 'adb-shell-dumpsys-gfxinfo-framestats',
    worstWindows: undefined,
  });
  assert.ok(
    findExactCallIndex(calls, 'shell', 'dumpsys', 'gfxinfo', 'com.example.app', 'reset') <
      findCallPrefixIndex(calls, 'shell', 'perfetto'),
  );
  assert.ok(findCallIndex(calls, 'stat -c %s') < findCallIndex(calls, 'pull'));
  assert.ok(findCallIndex(calls, 'rm -f') > findCallIndex(calls, 'pull'));
});

test('writeAndroidSimpleperfReport writes JSON report artifact without returning report contents', async () => {
  const tmpDir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'agent-device-simpleperf-report-test-'),
  );
  const outPath = path.join(tmpDir, 'cpu-report.json');
  const session: AndroidNativePerfSession = {
    type: 'cpu-profile',
    kind: 'simpleperf',
    packageName: 'com.example.app',
    appPid: '1234',
    profilerPid: '5678',
    remotePath: '/data/local/tmp/cpu.perf.data',
    outPath: path.join(tmpDir, 'cpu.perf.data'),
    startedAt: Date.now() - 2000,
    state: 'stopped',
  };
  const adb: AndroidAdbExecutor = async (args) => {
    if (args[0] === 'shell' && args[1]?.includes('command -v simpleperf')) {
      return { exitCode: 0, stdout: '/system/bin/simpleperf\n', stderr: '' };
    }
    if (args[0] === 'shell' && args[1] === 'simpleperf') {
      return {
        exitCode: 0,
        stdout: '12.34%  com.example.app  /data/app/libapp.so  Java_com_example_Foo\n',
        stderr: '',
      };
    }
    throw new Error(`Unexpected adb call: ${args.join(' ')}`);
  };

  const result = await writeAndroidSimpleperfReport(ANDROID_EMULATOR, session, outPath, { adb });
  const report = JSON.parse(await fsPromises.readFile(outPath, 'utf8')) as {
    entries: Array<{ percentage: number; symbol: string }>;
  };

  assert.equal(result.outPath, outPath);
  assert.equal(result.entryCount, 1);
  assert.equal(report.entries[0]?.percentage, 12.3);
  assert.equal(report.entries[0]?.symbol, 'Java_com_example_Foo');
  assert.equal('entries' in result, false);
});

test('startAndroidSimpleperfProfile fails with an actionable missing-process hint', async () => {
  const adb: AndroidAdbExecutor = async (args) => {
    if (args[0] === 'shell' && args[1] === 'pidof') {
      return { exitCode: 1, stdout: '', stderr: '' };
    }
    throw new Error(`Unexpected adb call: ${args.join(' ')}`);
  };

  await assert.rejects(
    startAndroidSimpleperfProfile(ANDROID_EMULATOR, 'com.example.app', '/tmp/cpu.perf.data', {
      adb,
    }),
    /No active Android app process/,
  );
});

function findCallIndex(calls: string[][], pattern: string): number {
  return calls.findIndex((args) => args.some((arg) => arg.includes(pattern)));
}

function findExactCallIndex(calls: string[][], ...expected: string[]): number {
  return calls.findIndex((args) => args.join('\0') === expected.join('\0'));
}

function findCallPrefixIndex(calls: string[][], ...expected: string[]): number {
  return calls.findIndex((args) => expected.every((value, index) => args[index] === value));
}

function makePerfettoTraceAdbExecutor(outPath: string, calls: string[][]): AndroidAdbExecutor {
  const responders = [
    staticAdbResponse(exactAdbArgs('shell', 'pidof', 'com.example.app'), '1234\n'),
    staticAdbResponse(containsAdbArg('command -v perfetto'), '/system/bin/perfetto\n'),
    staticAdbResponse(exactAdbArgs('shell', 'dumpsys', 'gfxinfo', 'com.example.app', 'reset')),
    staticAdbResponse(adbArgsPrefix('shell', 'perfetto'), '8765\n'),
    staticAdbResponse(containsAdbArg('kill -INT')),
    staticAdbResponse(containsAdbArg('stat -c %s'), '5\n'),
    pullAdbResponse(outPath, 'trace'),
    staticAdbResponse(
      exactAdbArgs('shell', 'dumpsys', 'gfxinfo', 'com.example.app', 'framestats'),
      [
        'Applications Graphics Acceleration Info:',
        'Uptime: 11000 Realtime: 11000',
        '** Graphics info for pid 1234 [com.example.app] **',
        'Stats since: 10000000000ns',
        'Total frames rendered: 10',
        'Janky frames: 2 (20.00%)',
        'Number Frame deadline missed: 2',
      ].join('\n'),
    ),
    staticAdbResponse(containsAdbArg('rm -f')),
  ];
  return async (args) => dispatchAdbResponse(args, calls, responders);
}

type MockAdbResult = Awaited<ReturnType<AndroidAdbExecutor>>;

type MockAdbResponder = {
  matches: (args: string[]) => boolean;
  run: (args: string[]) => Promise<MockAdbResult>;
};

async function dispatchAdbResponse(
  args: string[],
  calls: string[][],
  responders: MockAdbResponder[],
): Promise<MockAdbResult> {
  calls.push(args);
  const responder = responders.find((candidate) => candidate.matches(args));
  if (!responder) throw new Error(`Unexpected adb call: ${args.join(' ')}`);
  return await responder.run(args);
}

function staticAdbResponse(matches: MockAdbResponder['matches'], stdout = ''): MockAdbResponder {
  return {
    matches,
    run: async () => ({ exitCode: 0, stdout, stderr: '' }),
  };
}

function pullAdbResponse(outPath: string, contents: string): MockAdbResponder {
  return {
    matches: (args) => args[0] === 'pull',
    run: async () => {
      await fsPromises.writeFile(outPath, contents);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

function exactAdbArgs(...expected: string[]): MockAdbResponder['matches'] {
  return (args) => args.join('\0') === expected.join('\0');
}

function adbArgsPrefix(...expected: string[]): MockAdbResponder['matches'] {
  return (args) => expected.every((value, index) => args[index] === value);
}

function containsAdbArg(pattern: string): MockAdbResponder['matches'] {
  return (args) => args.some((arg) => arg.includes(pattern));
}
