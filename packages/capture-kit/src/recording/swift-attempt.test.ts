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
      releaseSwiftAttempt(attempt);
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
    releaseSwiftAttempt(attempt);
    for (let pass = 0; pass < 6; pass++) await reclaimSwiftAttempt(env, attemptName);
    expect(fs.lstatSync(attempt.data).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8')).toBe('unchanged');
    const fake = path.join(cache, 'attempts', 'overlay-AAAAAA');
    fs.symlinkSync(outside, fake, 'dir');
    await reclaimSwiftAttempt(env, 'overlay-AAAAAA');
    expect(fs.lstatSync(fake).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8')).toBe('unchanged');
    expect(fs.readdirSync(claims)).toEqual([]);
  } finally {
    fs.chmodSync(attempt.data, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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
    if (successor) releaseSwiftAttempt(successor);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    if (pid && startTime) {
      const facts = await readProcessIdentityFacts(pid);
      expect(facts.startTime !== startTime || facts.zombie).toBe(true);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 10000);
