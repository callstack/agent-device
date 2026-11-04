import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  commandHostEnvironment,
  withCommandExecutorOverride,
  withCommandHost,
  withoutCommandExecutorOverride,
} from '@agent-device/host-kit/command';
import { readProcessIdentityFacts } from '@agent-device/host-kit/process';
import { Deadline } from '@agent-device/host-kit/retry';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { createScreenRecordingRuntimeHost } from './platform-runtime-screen-recording-host.ts';

const budget = vi.hoisted(() => ({ ms: 10000 }));
vi.mock(import('@agent-device/capture-kit/recording-overlay'), async (importOriginal) => ({
  ...(await importOriginal()),
  startRecordingOverlayBudget: () => Deadline.fromTimeoutMs(budget.ms),
}));

type Identity = { pid: number; startTime: string };
type Descendant = {
  trigger: string;
  done: string;
  compiler: Identity;
  frontend: Identity;
  targets: string[];
};

const frontendScript = String.raw`
  const fs = require('node:fs'); const path = require('node:path');
  const [trigger, done, ready, ...targets] = process.argv.slice(1);
  const fds = targets.map(target => { fs.mkdirSync(path.dirname(target), { recursive: true }); return fs.openSync(target, 'a'); });
  fs.writeFileSync(ready, 'ready');
  const timer = setInterval(() => {
    if (!fs.existsSync(trigger)) return;
    const blocked = [];
    for (let index = 0; index < targets.length; index++) {
      const target = targets[index];
      fs.writeSync(fds[index], ' late via open descriptor');
      fs.closeSync(fds[index]);
      try { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'late private write'); blocked.push('wrote'); } catch (error) { blocked.push(error.code); }
    }
    fs.writeFileSync(done, JSON.stringify(blocked)); clearInterval(timer);
  }, 10);
  setTimeout(() => clearInterval(timer), 10000).unref();
`;
const compilerScript = String.raw`
  const fs = require('node:fs'); const { spawn } = require('node:child_process');
  const [frontendScript, trigger, done, ready, release, ...targets] = process.argv.slice(1);
  const child = spawn(process.execPath, ['-e', frontendScript, trigger, done, ready, ...targets], { detached: true, stdio: 'ignore' });
  child.unref(); let reported = false;
  const timer = setInterval(() => {
    if (!reported && fs.existsSync(ready)) { reported = true; process.stdout.write(String(child.pid)); }
    if (fs.existsSync(release)) clearInterval(timer);
  }, 10);
  setTimeout(() => clearInterval(timer), 10000).unref();
`;

async function identity(pid: number): Promise<Identity> {
  const facts = await withoutCommandExecutorOverride(() => readProcessIdentityFacts(pid));
  if (!facts.startTime) throw new Error(`missing identity for ${pid}`);
  return { pid, startTime: facts.startTime };
}

async function startDescendant(
  root: string,
  env: NodeJS.ProcessEnv,
  targets: string[],
): Promise<Descendant> {
  for (const target of targets) {
    if (!target.startsWith(`${root}${path.sep}`))
      throw new Error(`target is outside fixture root: ${target}`);
  }
  const control = fs.mkdtempSync(path.join(root, 'control-'));
  const trigger = path.join(control, 'trigger');
  const done = path.join(control, 'done');
  const release = path.join(control, 'release');
  const ready = path.join(control, 'ready');
  const child = spawn(
    process.execPath,
    ['-e', compilerScript, frontendScript, trigger, done, ready, release, ...targets],
    {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const exited = once(child, 'exit');
  if (!child.pid || !child.stdout) throw new Error('fixture compiler did not start');
  const compiler = await identity(child.pid);
  const [chunk] = await once(child.stdout, 'data');
  const frontend = await identity(Number(String(chunk)));
  fs.writeFileSync(release, 'exit');
  await exited;
  return { trigger, done, compiler, frontend, targets };
}

async function releaseDescendant(child: Descendant): Promise<void> {
  fs.writeFileSync(child.trigger, 'continue');
  await vi.waitFor(() => expect(fs.existsSync(child.done)).toBe(true), {
    timeout: 3000,
  });
  const blocked = JSON.parse(fs.readFileSync(child.done, 'utf8')) as string[];
  expect(blocked).toHaveLength(child.targets.length);
  for (const reason of blocked) expect(['ENOTDIR', 'EEXIST']).toContain(reason);
  await vi.waitFor(
    async () => {
      const facts = await withoutCommandExecutorOverride(() =>
        readProcessIdentityFacts(child.frontend.pid),
      );
      expect(facts.startTime !== child.frontend.startTime || facts.zombie).toBe(true);
    },
    { timeout: 3000 },
  );
}

const raw = Buffer.from('0000000c6674797069736f6d000000086d6f6f76', 'hex');
const composited = Buffer.concat([raw, Buffer.from('0000000866726565', 'hex')]);

function setup() {
  const root = mkdtempForTestSync('screen-finalizer-isolation-');
  const cache = path.join(root, 'cache');
  const sentinel = path.join(root, 'sentinel');
  fs.mkdirSync(sentinel);
  fs.writeFileSync(path.join(sentinel, 'sentinel'), 'unchanged');
  const makeHost = (name: string) => {
    const claims = path.join(root, `${name}-claims`);
    fs.mkdirSync(claims);
    const env = {
      ...process.env,
      AGENT_DEVICE_CLAIMS_DIR: claims,
      AGENT_DEVICE_SWIFT_CACHE_DIR: cache,
    };
    return {
      claims,
      env,
      runtime: createScreenRecordingRuntimeHost({
        host: createTestHostEnvironment({ cwd: root, env }),
      }),
    };
  };
  return { root, cache, sentinel, first: makeHost('first'), second: makeHost('second') };
}

function input(root: string, name: string, touches = false) {
  const outputPath = path.join(root, `${name}.mp4`);
  fs.writeFileSync(outputPath, raw);
  return {
    outputPath,
    showTouches: touches,
    gestureEvents: touches ? [{ kind: 'tap' as const, tMs: 0, x: 1, y: 1 }] : [],
    targetLabel: name,
  };
}

async function cleanup(
  fixture: ReturnType<typeof setup>,
  children: Descendant[],
  platform: PropertyDescriptor,
) {
  try {
    for (const child of children) if (!fs.existsSync(child.done)) await releaseDescendant(child);
    for (const child of children) {
      const facts = await readProcessIdentityFacts(child.frontend.pid);
      expect(facts.startTime !== child.frontend.startTime || facts.zombie).toBe(true);
    }
    await fixture.first.runtime.closeValidatorPreparation();
    await fixture.second.runtime.closeValidatorPreparation();
    expect(fs.readdirSync(fixture.first.claims)).toEqual([]);
    expect(fs.readdirSync(fixture.second.claims)).toEqual([]);
    expect(fs.readFileSync(path.join(fixture.sentinel, 'sentinel'), 'utf8')).toBe('unchanged');
    console.log('isolated owned processes exited', { root: fixture.root, children });
    fs.rmSync(fixture.root, { recursive: true, force: true });
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
}

test('a late compiler cannot mutate a parent-published executable reused by another host', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  const fixture = setup();
  const children: Descendant[] = [];
  let compiles = 0;
  try {
    await withCommandHost(
      {
        host: createTestHostEnvironment({ cwd: fixture.root, env: fixture.first.env }),
        requestEnv: {
          HOME: fixture.sentinel,
          TMPDIR: fixture.sentinel,
          CLANG_MODULE_CACHE_PATH: fixture.sentinel,
          DEVELOPER_DIR: '/requested/developer',
        },
      },
      async () =>
        await withCommandExecutorOverride(
          (command, args, options) => {
            if (command !== 'xcrun')
              return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
            return (async () => {
              compiles++;
              const work = options.cwd!;
              const source = args[2]!;
              const output = args[args.indexOf('-o') + 1]!;
              expect(args.slice(0, 2)).toEqual(['--no-cache', 'swiftc']);
              expect(source.startsWith(`${work}${path.sep}`)).toBe(true);
              expect(output.startsWith(`${work}${path.sep}`)).toBe(true);
              expect(options.env?.TMPDIR).toBe(path.join(work, 'tmp'));
              expect(options.env?.HOME).toBe(path.join(work, 'home'));
              expect(options.env?.DEVELOPER_DIR).toBe('/requested/developer');
              expect(commandHostEnvironment().env).toEqual(options.env);
              expect(options.env?.CLANG_MODULE_CACHE_PATH).toBe(path.join(work, 'module-cache'));
              expect(options.env?.SWIFT_MODULECACHE_PATH).toBe(path.join(work, 'module-cache'));
              expect(options.env).not.toHaveProperty('AGENT_DEVICE_SWIFT_CACHE_DIR');
              fs.writeFileSync(output, 'published compiler bytes', { mode: 0o755 });
              children.push(
                await startDescendant(fixture.root, fixture.first.env, [
                  source,
                  output,
                  path.join(work, 'module-cache', 'late'),
                  path.join(work, 'tmp', 'late'),
                ]),
              );
              return { exitCode: 0, stdout: '', stderr: '' };
            })();
          },
          async () => {
            await fixture.first.runtime.finalize.prepare({ container: 'mp4' });
            const bin = path.join(fixture.cache, 'bin');
            await vi.waitFor(() =>
              expect(fs.readdirSync(bin).some((name) => !name.endsWith('.lock'))).toBe(true),
            );
            const executable = path.join(
              bin,
              fs.readdirSync(bin).find((name) => !name.endsWith('.lock'))!,
            );
            expect(fs.readFileSync(executable, 'utf8')).toBe('published compiler bytes');
            await fixture.first.runtime.finalize.complete(input(fixture.root, 'first'));
            await fixture.second.runtime.finalize.complete(input(fixture.root, 'second'));
            expect(compiles).toBe(1);
            expect(children).toHaveLength(1);
            console.log('compiler attempt before late write', {
              root: fixture.root,
              cache: fixture.cache,
              executable,
              child: children[0],
            });
            await releaseDescendant(children[0]!);
            expect(fs.readFileSync(executable, 'utf8')).toBe('published compiler bytes');
            for (const target of children[0]!.targets) expect(fs.existsSync(target)).toBe(false);
            const attempt = children[0]!.targets[0]!.split(
              `${path.sep}alias${path.sep}work${path.sep}`,
            )[0]!;
            expect(fs.existsSync(path.join(attempt, 'pending.json'))).toBe(true);
          },
        ),
    );
  } finally {
    await cleanup(fixture, children, platform);
  }
}, 10000);

test.each(['compiler-warning', 'helper-warning', 'helper-success'] as const)(
  '%s keeps late attempt writes away from both recording outputs and the successor cache',
  async (mode) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const fixture = setup();
    const children: Descendant[] = [];
    let overlayCompiles = 0;
    let overlayRuns = 0;
    try {
      await withCommandExecutorOverride(
        (command, args, options) => {
          if (command === 'xcrun')
            return (async () => {
              const output = args[args.indexOf('-o') + 1]!;
              if (path.basename(output).startsWith('recording-overlay-')) {
                overlayCompiles++;
                if (mode === 'compiler-warning' && overlayCompiles === 1) {
                  children.push(
                    await startDescendant(fixture.root, fixture.first.env, [
                      output,
                      path.join(options.cwd!, 'module-cache', 'late'),
                    ]),
                  );
                  throw new AppError('COMMAND_FAILED', 'test compiler timeout', {
                    timeoutMs: options.timeoutMs,
                  });
                }
              }
              fs.writeFileSync(output, 'compiler result', { mode: 0o755 });
              return { exitCode: 0, stdout: '', stderr: '' };
            })();
          if (!args.includes('--output'))
            return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
          return (async () => {
            overlayRuns++;
            const output = args[args.indexOf('--output') + 1]!;
            const source = args[args.indexOf('--input') + 1]!;
            const events = args[args.indexOf('--events') + 1]!;
            expect(path.dirname(output)).toBe(options.cwd);
            expect(path.dirname(source)).toBe(options.cwd);
            expect(path.dirname(events)).toBe(options.cwd);
            fs.writeFileSync(output, composited);
            if (mode !== 'compiler-warning' && overlayRuns === 1) {
              children.push(await startDescendant(fixture.root, fixture.first.env, [output]));
              if (mode === 'helper-warning')
                throw new AppError('COMMAND_FAILED', 'test helper timeout', {
                  timeoutMs: options.timeoutMs,
                });
            }
            return { exitCode: 0, stdout: '', stderr: '' };
          })();
        },
        async () => {
          await fixture.first.runtime.finalize.prepare({ container: 'mp4' });
          await vi.waitFor(() =>
            expect(
              fs.existsSync(path.join(fixture.cache, 'bin')) &&
                fs
                  .readdirSync(path.join(fixture.cache, 'bin'))
                  .some((name) => name.startsWith('video-validator-') && !name.endsWith('.lock')),
            ).toBe(true),
          );
          const first = input(fixture.root, 'first-overlay', true);
          const second = input(fixture.root, 'second-overlay', true);
          const result = await fixture.first.runtime.finalize.complete(first);
          if (mode === 'helper-success') expect(result.overlayWarning).toBeUndefined();
          else expect(result.overlayWarning).toContain('failed to overlay');
          await fixture.second.runtime.finalize.complete(second);
          const beforeFirst = fs.readFileSync(first.outputPath);
          const beforeSecond = fs.readFileSync(second.outputPath);
          expect(beforeFirst).toEqual(mode === 'helper-success' ? composited : raw);
          expect(beforeSecond).toEqual(composited);
          expect(children).toHaveLength(1);
          const bin = path.join(fixture.cache, 'bin');
          const overlayBin = path.join(
            bin,
            fs
              .readdirSync(bin)
              .find((name) => name.startsWith('recording-overlay-') && !name.endsWith('.lock'))!,
          );
          const cached = fs.readFileSync(overlayBin);
          console.log('overlay attempt before late write', {
            root: fixture.root,
            cache: fixture.cache,
            first: first.outputPath,
            second: second.outputPath,
            child: children[0],
          });
          await releaseDescendant(children[0]!);
          expect(fs.readFileSync(first.outputPath)).toEqual(beforeFirst);
          expect(fs.readFileSync(second.outputPath)).toEqual(beforeSecond);
          expect(fs.readFileSync(overlayBin)).toEqual(cached);
          for (const target of children[0]!.targets) expect(fs.existsSync(target)).toBe(false);
          const attemptDir = children[0]!.targets[0]!.split(
            `${path.sep}alias${path.sep}work${path.sep}`,
          )[0]!;
          expect(fs.readFileSync(path.join(attemptDir, 'pending.json'), 'utf8')).toContain(
            '"kind"',
          );
        },
      );
    } finally {
      await cleanup(fixture, children, platform);
    }
  },
  10000,
);

test('failed early stop leaves shared validator preparation running in its private attempt', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  const fixture = setup();
  const children: Descendant[] = [];
  let finish!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let compiles = 0;
  let compilerSignal: AbortSignal | undefined;
  budget.ms = 100;
  try {
    await withCommandExecutorOverride(
      (command, args, options) => {
        if (command !== 'xcrun') return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
        return (async () => {
          compiles++;
          compilerSignal = options.signal;
          const output = args[args.indexOf('-o') + 1]!;
          children.push(await startDescendant(fixture.root, fixture.first.env, [output]));
          entered();
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          fs.writeFileSync(output, 'validator snapshot', { mode: 0o755 });
          fs.chmodSync(output, 0o755);
          return { exitCode: 0, stdout: '', stderr: '' };
        })();
      },
      async () => {
        await fixture.first.runtime.finalize.prepare({ container: 'mp4' });
        await started;
        const first = input(fixture.root, 'failed-stop');
        await expect(fixture.first.runtime.finalize.complete(first)).rejects.toMatchObject({
          details: { reason: 'video_validator_not_prepared' },
        });
        expect(compilerSignal?.aborted).toBe(false);
        expect(compiles).toBe(1);
        expect(fs.readFileSync(first.outputPath)).toEqual(raw);
        finish();
        const bin = path.join(fixture.cache, 'bin');
        await vi.waitFor(() =>
          expect(fs.readdirSync(bin).some((name) => !name.endsWith('.lock'))).toBe(true),
        );
        const executable = path.join(
          bin,
          fs.readdirSync(bin).find((name) => !name.endsWith('.lock'))!,
        );
        budget.ms = 10000;
        await fixture.second.runtime.finalize.complete(input(fixture.root, 'retry'));
        expect(compiles).toBe(1);
        console.log('failed stop attempt before late write', {
          root: fixture.root,
          cache: fixture.cache,
          executable,
          child: children[0],
        });
        await releaseDescendant(children[0]!);
        expect(fs.readFileSync(executable, 'utf8')).toBe('validator snapshot');
        expect(fs.existsSync(children[0]!.targets[0]!)).toBe(false);
        const attempt = children[0]!.targets[0]!.split(
          `${path.sep}alias${path.sep}work${path.sep}`,
        )[0]!;
        expect(fs.existsSync(path.join(attempt, 'pending.json'))).toBe(true);
      },
    );
  } finally {
    finish?.();
    budget.ms = 10000;
    await cleanup(fixture, children, platform);
  }
}, 10000);
