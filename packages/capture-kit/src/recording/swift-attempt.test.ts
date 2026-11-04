import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '../tmp-dir.fixtures.ts';
import { readProcessIdentityFacts } from '@agent-device/host-kit/process';
import {
  createSwiftAttempt,
  releaseSwiftAttempt,
  reclaimSwiftAttempt,
  reclaimSwiftPublication,
  scheduleSwiftPublicationRecovery,
  swiftPublicationPath,
} from './swift-attempt.ts';

test.each(['root', 'nested'] as const)(
  'seals and reclaims a private tree while a descendant retains its %s cwd and file descriptor',
  async (location) => {
    const root = mkdtempForTestSync('swift-attempt-reclaim-');
    const cache = path.join(root, 'cache');
    const claims = path.join(root, 'claims');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(claims);
    fs.mkdirSync(outside);
    const sentinel = path.join(outside, 'sentinel');
    fs.writeFileSync(sentinel, 'unchanged');
    const env = {
      ...process.env,
      AGENT_DEVICE_CLAIMS_DIR: claims,
      AGENT_DEVICE_SWIFT_CACHE_DIR: cache,
    };
    const attempt = createSwiftAttempt(env, 'overlay');
    fs.writeFileSync(path.join(attempt.work, 'large.mp4'), Buffer.alloc(1024 * 1024));
    fs.symlinkSync(outside, path.join(attempt.work, 'foreign'), 'dir');
    const ready = path.join(root, 'ready');
    const trigger = path.join(root, 'trigger');
    const done = path.join(root, 'done');
    const script = String.raw`
    const fs = require('node:fs');
    const [ready, trigger, done, location] = process.argv.slice(1);
    const fd = fs.openSync(location === 'nested' ? '../large.mp4' : 'large.mp4', 'a'); fs.writeFileSync(ready, 'ready');
    const timer = setInterval(() => {
      if (!fs.existsSync(trigger)) return;
      fs.writeSync(fd, 'late'); fs.closeSync(fd);
      let outcome = 'wrote';
      try { fs.writeFileSync('recreated.mp4', 'late'); } catch (error) { outcome = error.code; }
      fs.writeFileSync(done, outcome); clearInterval(timer);
    }, 10);
    setTimeout(() => clearInterval(timer), 10000).unref();
  `;
    const child = spawn(process.execPath, ['-e', script, ready, trigger, done, location], {
      cwd: location === 'nested' ? path.join(attempt.work, 'tmp') : attempt.work,
      env,
      stdio: 'ignore',
    });
    const exited = once(child, 'exit');
    let pid: number | undefined;
    let startTime: string | null = null;
    try {
      if (!child.pid) throw new Error('fixture child did not start');
      pid = child.pid;
      startTime = (await readProcessIdentityFacts(pid)).startTime;
      expect(startTime).toBeTruthy();
      await vi.waitFor(() => expect(fs.existsSync(ready)).toBe(true));
      console.log('attempt cleanup fixture', {
        root,
        claims,
        cache,
        attempt: attempt.directory,
        pid,
        startTime,
      });
      await releaseSwiftAttempt(attempt);
      expect(fs.lstatSync(attempt.work).isFile()).toBe(true);
      await vi.waitFor(
        () => {
          expect(fs.lstatSync(attempt.data).isFile()).toBe(true);
        },
        { timeout: 3000 },
      );
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('unchanged');
      expect(fs.existsSync(path.join(attempt.directory, 'pending.json'))).toBe(true);
      fs.writeFileSync(trigger, 'continue');
      await exited;
      expect(fs.readFileSync(done, 'utf8')).toBe('ENOENT');
      expect(fs.lstatSync(attempt.data).isFile()).toBe(true);
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('unchanged');
    } finally {
      if (!fs.existsSync(trigger)) fs.writeFileSync(trigger, 'cleanup');
      if (child.exitCode === null && child.signalCode === null) await exited;
      if (pid && startTime) {
        const facts = await readProcessIdentityFacts(pid);
        expect(facts.startTime !== startTime || facts.zombie).toBe(true);
      }
      fs.chmodSync(attempt.data, 0o700);
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  10000,
);

test('recovers only an exact crashed publication inode and its private work', async () => {
  const root = mkdtempForTestSync('swift-publication-reclaim-');
  const cache = path.join(root, 'cache');
  const claims = path.join(root, 'claims');
  fs.mkdirSync(claims);
  const video = path.join(root, 'recording.mp4');
  fs.writeFileSync(video, 'raw video');
  const env = {
    ...process.env,
    AGENT_DEVICE_CLAIMS_DIR: claims,
    AGENT_DEVICE_SWIFT_CACHE_DIR: cache,
  };
  const fixture = fileURLToPath(
    new URL('./__tests__/test-utils/swift-publication-owner.ts', import.meta.url),
  );
  const child = spawn(process.execPath, ['--experimental-strip-types', fixture, root], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let pid: number | undefined;
  let startTime: string | null = null;
  try {
    if (!child.pid || !child.stdout) throw new Error('fixture owner did not start');
    pid = child.pid;
    startTime = (await readProcessIdentityFacts(pid)).startTime;
    expect(startTime).toBeTruthy();
    const [chunk] = await once(child.stdout, 'data');
    const checkpoint = JSON.parse(String(chunk)) as {
      attempt: string;
      publication: string;
      videoPath: string;
    };
    expect(checkpoint.videoPath).toBe(video);
    console.log('publication cleanup fixture', {
      root,
      claims,
      cache,
      pid,
      startTime,
      ...checkpoint,
    });
    child.kill('SIGKILL');
    await exited;
    const wrongVideo = path.join(root, 'other.mp4');
    const wrongPublication = swiftPublicationPath(wrongVideo, checkpoint.attempt);
    fs.writeFileSync(wrongPublication, 'unrelated');
    await reclaimSwiftPublication(env, wrongVideo, checkpoint.attempt);
    expect(fs.readFileSync(wrongPublication, 'utf8')).toBe('unrelated');
    const backup = path.join(root, 'owned-backup');
    fs.linkSync(checkpoint.publication, backup);
    fs.unlinkSync(checkpoint.publication);
    fs.writeFileSync(checkpoint.publication, 'replacement');
    await reclaimSwiftPublication(env, video, checkpoint.attempt);
    expect(fs.readFileSync(checkpoint.publication, 'utf8')).toBe('replacement');
    fs.unlinkSync(checkpoint.publication);
    fs.symlinkSync(video, checkpoint.publication);
    await reclaimSwiftPublication(env, video, checkpoint.attempt);
    expect(fs.lstatSync(checkpoint.publication).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(video, 'utf8')).toBe('raw video');
    fs.unlinkSync(checkpoint.publication);
    fs.linkSync(backup, checkpoint.publication);
    fs.unlinkSync(backup);
    scheduleSwiftPublicationRecovery(env, video);
    await vi.waitFor(() => expect(fs.existsSync(checkpoint.publication)).toBe(false));
    expect(fs.readFileSync(video, 'utf8')).toBe('raw video');
    await reclaimSwiftAttempt(env, checkpoint.attempt);
    const attempt = path.join(cache, 'attempts', checkpoint.attempt);
    expect(fs.lstatSync(path.join(attempt, 'alias', 'work')).isFile()).toBe(true);
    expect(fs.existsSync(path.join(attempt, 'pending.json'))).toBe(true);
    expect(fs.lstatSync(path.join(attempt, 'data')).isFile()).toBe(true);
    expect(fs.readdirSync(claims)).toEqual([]);
    fs.chmodSync(path.join(attempt, 'data'), 0o700);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    if (pid && startTime) {
      const facts = await readProcessIdentityFacts(pid);
      expect(facts.startTime !== startTime || facts.zombie).toBe(true);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 10000);

test('bounded exact retries reclaim a large attempt and refuse a symlinked attempt root', async () => {
  const root = mkdtempForTestSync('swift-attempt-bounded-');
  const cache = path.join(root, 'cache');
  const claims = path.join(root, 'claims');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(claims);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'sentinel'), 'unchanged');
  const env = {
    ...process.env,
    AGENT_DEVICE_CLAIMS_DIR: claims,
    AGENT_DEVICE_SWIFT_CACHE_DIR: cache,
  };
  const attempt = createSwiftAttempt(env, 'compiler');
  for (let index = 0; index < 300; index++)
    fs.writeFileSync(path.join(attempt.work, `item-${index}`), 'x');
  fs.symlinkSync(outside, path.join(attempt.work, 'foreign'), 'dir');
  const attemptName = path.basename(attempt.directory);
  try {
    await reclaimSwiftAttempt(env, attemptName);
    expect(fs.readdirSync(attempt.data)).toHaveLength(305);
    await releaseSwiftAttempt(attempt);
    for (let pass = 0; pass < 6; pass++) await reclaimSwiftAttempt(env, attemptName);
    expect(fs.lstatSync(attempt.data).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8')).toBe('unchanged');
    const fake = path.join(cache, 'attempts', 'overlay-AAAAAA');
    fs.symlinkSync(outside, fake, 'dir');
    await reclaimSwiftAttempt(env, 'overlay-AAAAAA');
    expect(fs.lstatSync(fake).isSymbolicLink()).toBe(true);
    expect(await reclaimSwiftAttempt(env, 'compiler-AAAAAA')).toBe('pending');
    expect(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8')).toBe('unchanged');
    expect(fs.readdirSync(claims)).toEqual([]);
  } finally {
    fs.chmodSync(attempt.data, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failed live-owner closure can be retried exactly after the journal becomes writable', async () => {
  const root = mkdtempForTestSync('swift-close-retry-');
  const cache = path.join(root, 'cache');
  const claims = path.join(root, 'claims');
  fs.mkdirSync(claims);
  const env = {
    ...process.env,
    AGENT_DEVICE_CLAIMS_DIR: claims,
    AGENT_DEVICE_SWIFT_CACHE_DIR: cache,
  };
  const attempt = createSwiftAttempt(env, 'validator');
  const name = path.basename(attempt.directory);
  const failure = Object.assign(new Error('fixture'), { code: 'ENOSPC' });
  const rename = fs.renameSync;
  let failed = false;
  const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from, to) => {
    if (!failed && to === path.join(attempt.directory, 'pending.json')) {
      failed = true;
      throw failure;
    }
    return rename(from, to);
  }) as typeof fs.renameSync);
  try {
    await expect(releaseSwiftAttempt(attempt)).rejects.toThrow(failure);
    expect(fs.lstatSync(attempt.work).isSymbolicLink()).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(attempt.directory, 'pending.json'), 'utf8')).closed,
    ).toBe(false);
    spy.mockRestore();
    await reclaimSwiftAttempt(env, name);
    expect(fs.lstatSync(attempt.work).isFile()).toBe(true);
    expect(fs.lstatSync(attempt.data).isFile()).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(attempt.directory, 'pending.json'), 'utf8'))
        .dataTombstone,
    ).toEqual({ device: expect.any(String), inode: expect.any(String) });
    expect(fs.readdirSync(claims)).toEqual([]);
  } finally {
    spy.mockRestore();
    await reclaimSwiftAttempt(env, name).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an absent legacy data directory can be fenced without adopting an unknown fence file', async () => {
  const root = mkdtempForTestSync('swift-absent-fence-');
  const claims = path.join(root, 'claims');
  const cache = path.join(root, 'cache');
  fs.mkdirSync(claims);
  const env = {
    ...process.env,
    AGENT_DEVICE_CLAIMS_DIR: claims,
    AGENT_DEVICE_SWIFT_CACHE_DIR: cache,
  };
  const missing = createSwiftAttempt(env, 'compiler');
  const unknown = createSwiftAttempt(env, 'compiler');
  const unknownData = createSwiftAttempt(env, 'compiler');
  const unknownFence = path.join(unknown.directory, 'data-fence');
  fs.rmSync(missing.data, { recursive: true });
  fs.rmSync(unknownData.data, { recursive: true });
  fs.writeFileSync(unknownData.data, 'unknown data');
  fs.writeFileSync(unknownFence, 'unrecognized');
  try {
    await releaseSwiftAttempt(missing);
    await releaseSwiftAttempt(unknown);
    await releaseSwiftAttempt(unknownData);
    await reclaimSwiftAttempt(env, path.basename(missing.directory));
    await reclaimSwiftAttempt(env, path.basename(unknown.directory));
    expect(await reclaimSwiftAttempt(env, path.basename(unknownData.directory))).toBe('pending');
    expect(fs.lstatSync(missing.data).isFile()).toBe(true);
    expect(fs.readFileSync(unknownFence, 'utf8')).toBe('unrecognized');
    expect(fs.lstatSync(unknown.data).isDirectory()).toBe(true);
    expect(fs.readFileSync(unknownData.data, 'utf8')).toBe('unknown data');
    expect(
      fs.existsSync(path.join(cache, 'pending-attempts', path.basename(unknownData.directory))),
    ).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(unknown.directory, 'pending.json'), 'utf8'))
        .dataTombstone,
    ).toBeUndefined();
    expect(
      fs.existsSync(path.join(cache, 'pending-attempts', path.basename(unknown.directory))),
    ).toBe(true);
    expect(fs.readdirSync(claims)).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a live owner retry preserves a foreign fence while concurrent reclaimers serialize', async () => {
  const root = mkdtempForTestSync('swift-attempt-transaction-');
  const claims = path.join(root, 'claims');
  const cache = path.join(root, 'cache');
  const sentinel = path.join(root, 'sentinel');
  fs.mkdirSync(claims);
  fs.mkdirSync(sentinel);
  fs.writeFileSync(path.join(sentinel, 'keep'), 'untouched');
  const env = {
    ...process.env,
    AGENT_DEVICE_CLAIMS_DIR: claims,
    AGENT_DEVICE_SWIFT_CACHE_DIR: cache,
  };
  const fixture = fileURLToPath(
    new URL('./__tests__/test-utils/swift-attempt-transaction.ts', import.meta.url),
  );
  const children: Array<{
    child: ReturnType<typeof spawn>;
    exited: Promise<unknown>;
    pid: number;
    startTime: string;
  }> = [];
  const start = async (role: string, attempt?: string) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', fixture, root, role, ...(attempt ? [attempt] : [])],
      { cwd: root, env, stdio: 'ignore' },
    );
    const exited = once(child, 'exit');
    if (!child.pid) throw new Error('fixture did not start');
    const startTime = (await readProcessIdentityFacts(child.pid)).startTime;
    if (!startTime) throw new Error('missing fixture identity');
    children.push({ child, exited, pid: child.pid, startTime });
    console.log('attempt transaction process', {
      root,
      claims,
      cache,
      sentinel,
      role,
      pid: child.pid,
      startTime,
    });
    return { exited };
  };
  const waitFile = async (name: string) =>
    await vi.waitFor(() => expect(fs.existsSync(path.join(root, name))).toBe(true), {
      timeout: 5000,
    });
  const signalFile = (name: string) => fs.writeFileSync(path.join(root, name), 'go');
  try {
    const owner = await start('owner');
    await waitFile('owner-ready');
    await waitFile('sweep-closed');
    const { attempt, data } = JSON.parse(
      fs.readFileSync(path.join(root, 'owner-ready'), 'utf8'),
    ) as { attempt: string; data: string };
    const directory = path.join(cache, 'attempts', attempt);
    console.log('attempt transaction roots', { root, claims, cache, sentinel, attempt, data });
    signalFile('owner-go');
    await waitFile('owner-failed');
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'pending.json'), 'utf8')).closed).toBe(
      true,
    );
    expect(fs.lstatSync(path.join(directory, 'alias', 'work')).isSymbolicLink()).toBe(true);
    const first = await start('first', attempt);
    await waitFile('first-ready');
    signalFile('first-start');
    await waitFile('first-holding');
    const second = await start('second', attempt);
    await waitFile('second-ready');
    signalFile('second-start');
    await waitFile('second-result');
    expect(JSON.parse(fs.readFileSync(path.join(root, 'second-result'), 'utf8'))).toBe('pending');
    signalFile('first-go');
    await first.exited;
    expect(JSON.parse(fs.readFileSync(path.join(root, 'first-result'), 'utf8'))).toBe('fenced');
    const before = JSON.parse(fs.readFileSync(path.join(directory, 'pending.json'), 'utf8'));
    const stat = fs.lstatSync(data, { bigint: true });
    expect(before.dataTombstone).toEqual({ device: String(stat.dev), inode: String(stat.ino) });
    expect(fs.existsSync(path.join(cache, 'pending-attempts', attempt))).toBe(false);
    signalFile('second-retry');
    await second.exited;
    expect(JSON.parse(fs.readFileSync(path.join(root, 'second-retried'), 'utf8'))).toBe('fenced');
    signalFile('owner-retry');
    await waitFile('owner-retried');
    const after = JSON.parse(fs.readFileSync(path.join(directory, 'pending.json'), 'utf8'));
    expect(after.dataTombstone).toEqual(before.dataTombstone);
    expect(fs.existsSync(path.join(cache, 'pending-attempts', attempt))).toBe(false);
    expect(fs.readFileSync(path.join(sentinel, 'keep'), 'utf8')).toBe('untouched');
    expect(fs.readdirSync(claims)).toEqual([]);
    signalFile('owner-done');
    await owner.exited;
  } finally {
    for (const name of [
      'owner-go',
      'owner-retry',
      'owner-done',
      'first-start',
      'first-go',
      'second-start',
      'second-retry',
    ])
      signalFile(name);
    for (const { exited, pid, startTime } of children) {
      await exited;
      const facts = await readProcessIdentityFacts(pid);
      expect(facts.startTime !== startTime || facts.zombie).toBe(true);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20000);

test.each(['rmdir', 'rmdir-recreate', 'create', 'journal', 'install'] as const)(
  'a crashed fence owner leaves %s recoverable or explicitly pending',
  async (scenario) => {
    const root = mkdtempForTestSync('swift-fence-crash-');
    const cache = path.join(root, 'cache');
    const claims = path.join(root, 'claims');
    const sentinel = path.join(root, 'sentinel');
    fs.mkdirSync(claims);
    fs.mkdirSync(sentinel);
    fs.writeFileSync(path.join(sentinel, 'keep'), 'untouched');
    const env = {
      ...process.env,
      AGENT_DEVICE_CLAIMS_DIR: claims,
      AGENT_DEVICE_SWIFT_CACHE_DIR: cache,
    };
    const fixture = fileURLToPath(
      new URL('./__tests__/test-utils/swift-fence-crash-owner.ts', import.meta.url),
    );
    const owner = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        fixture,
        root,
        scenario === 'rmdir-recreate' ? 'rmdir' : scenario,
      ],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const ownerExit = once(owner, 'exit');
    let writer: ReturnType<typeof spawn> | undefined;
    let writerExit: Promise<unknown> | undefined;
    let ownerStart: string | null = null;
    let writerStart: string | null = null;
    try {
      if (!owner.pid || !owner.stdout) throw new Error('fixture owner did not start');
      ownerStart = (await readProcessIdentityFacts(owner.pid)).startTime;
      expect(ownerStart).toBeTruthy();
      const [initial] = await once(owner.stdout, 'data');
      const checkpoint = JSON.parse(String(initial)) as { attempt: string; data: string };
      const directory = path.join(cache, 'attempts', checkpoint.attempt);
      await reclaimSwiftAttempt(env, checkpoint.attempt);
      expect(fs.lstatSync(path.join(directory, 'alias', 'work')).isSymbolicLink()).toBe(true);
      if (scenario === 'rmdir-recreate') {
        const script = String.raw`
          const fs = require('node:fs'); const [data, root] = process.argv.slice(1);
          fs.writeFileSync(root + '/writer-ready', 'ready');
          const timer = setInterval(() => {
            if (!fs.existsSync(root + '/writer-go')) return;
            try { fs.mkdirSync(data); fs.writeFileSync(data + '/late', 'private'); fs.writeFileSync(root + '/writer-done', 'created'); }
            catch (error) { fs.writeFileSync(root + '/writer-done', error.code); }
            clearInterval(timer);
          }, 10);
          setTimeout(() => clearInterval(timer), 10000).unref();
        `;
        writer = spawn(process.execPath, ['-e', script, checkpoint.data, root], {
          cwd: root,
          env,
          detached: true,
          stdio: 'ignore',
        });
        writerExit = once(writer, 'exit');
        if (!writer.pid) throw new Error('fixture writer did not start');
        writerStart = (await readProcessIdentityFacts(writer.pid)).startTime;
        expect(writerStart).toBeTruthy();
        await vi.waitFor(() => expect(fs.existsSync(path.join(root, 'writer-ready'))).toBe(true));
      }
      console.log('fence crash fixture', {
        scenario,
        root,
        cache,
        claims,
        sentinel,
        ...checkpoint,
        ownerPid: owner.pid,
        ownerStart,
        writerPid: writer?.pid,
        writerStart,
      });
      const reached = once(owner.stdout, 'data');
      fs.writeFileSync(path.join(root, 'begin'), 'begin');
      const [event] = await reached;
      expect(JSON.parse(String(event)).checkpoint).toBe(
        scenario === 'rmdir-recreate' ? 'rmdir' : scenario,
      );
      owner.kill('SIGKILL');
      await ownerExit;
      if (writer) {
        fs.writeFileSync(path.join(root, 'writer-go'), 'go');
        await writerExit;
        expect(fs.readFileSync(path.join(root, 'writer-done'), 'utf8')).toBe('created');
        expect(fs.readFileSync(path.join(checkpoint.data, 'late'), 'utf8')).toBe('private');
      }
      await reclaimSwiftAttempt(env, checkpoint.attempt);
      const record = JSON.parse(fs.readFileSync(path.join(directory, 'pending.json'), 'utf8'));
      const pending = path.join(cache, 'pending-attempts', checkpoint.attempt);
      const data = fs.lstatSync(checkpoint.data, { bigint: true });
      expect(data.isFile()).toBe(true);
      expect(record.dataTombstone).toEqual({ device: String(data.dev), inode: String(data.ino) });
      expect(fs.existsSync(pending)).toBe(false);
      expect(fs.readFileSync(path.join(sentinel, 'keep'), 'utf8')).toBe('untouched');
      expect(fs.readdirSync(claims)).toEqual([]);
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
      await ownerExit;
      if (writer && writer.exitCode === null && writer.signalCode === null) {
        fs.writeFileSync(path.join(root, 'writer-go'), 'cleanup');
        await writerExit;
      }
      if (owner.pid && ownerStart)
        expect((await readProcessIdentityFacts(owner.pid)).startTime).not.toBe(ownerStart);
      if (writer?.pid && writerStart)
        expect((await readProcessIdentityFacts(writer.pid)).startTime).not.toBe(writerStart);
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  10000,
);

test('a bounded owner sweep progresses past earlier crash records', async () => {
  const root = mkdtempForTestSync('swift-attempt-orphans-');
  const cache = path.join(root, 'cache');
  const claims = path.join(root, 'claims');
  fs.mkdirSync(claims);
  const env = {
    ...process.env,
    AGENT_DEVICE_CLAIMS_DIR: claims,
    AGENT_DEVICE_SWIFT_CACHE_DIR: cache,
  };
  const fixture = fileURLToPath(
    new URL('./__tests__/test-utils/swift-attempt-orphan-owner.ts', import.meta.url),
  );
  const child = spawn(process.execPath, ['--experimental-strip-types', fixture, root], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let pid: number | undefined;
  let startTime: string | null = null;
  let successor: ReturnType<typeof createSwiftAttempt> | undefined;
  try {
    if (!child.pid || !child.stdout) throw new Error('fixture owner did not start');
    pid = child.pid;
    startTime = (await readProcessIdentityFacts(pid)).startTime;
    expect(startTime).toBeTruthy();
    const [chunk] = await once(child.stdout, 'data');
    const { attempts } = JSON.parse(String(chunk)) as { attempts: string[] };
    expect(attempts).toHaveLength(12);
    console.log('orphan cleanup fixture', { root, cache, claims, pid, startTime, attempts });
    child.kill('SIGKILL');
    await exited;
    successor = createSwiftAttempt(env, 'validator');
    await vi.waitFor(
      () => {
        const pending = fs.readdirSync(path.join(cache, 'pending-attempts'));
        expect(pending).toEqual([path.basename(successor!.directory)]);
      },
      { timeout: 4000 },
    );
    for (const name of attempts) {
      const directory = path.join(cache, 'attempts', name);
      expect(fs.lstatSync(path.join(directory, 'alias', 'work')).isFile()).toBe(true);
      expect(fs.lstatSync(path.join(directory, 'data')).isFile()).toBe(true);
      expect(fs.existsSync(path.join(directory, 'pending.json'))).toBe(true);
    }
    expect(fs.readdirSync(claims)).toEqual([]);
  } finally {
    if (successor) await releaseSwiftAttempt(successor);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    if (pid && startTime) {
      const facts = await readProcessIdentityFacts(pid);
      expect(facts.startTime !== startTime || facts.zombie).toBe(true);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 10000);
