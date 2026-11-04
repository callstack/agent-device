import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readCurrentOwnerIdentity,
  readProcessIdentityFacts,
  isProcessAlive,
  isProcessPid,
} from '@agent-device/host-kit/process';
import { publishFileSync } from '@agent-device/host-kit/file';
import { withRestrictedCommandEnvironment } from '@agent-device/host-kit/command';

const ATTEMPT_NAME = /^(compiler|overlay|validator)-[A-Za-z0-9]{6}$/;
const MAX_ATTEMPTS = 8;
const MAX_ENTRIES = 128;
const MAX_DEPTH = 12;
const MAX_BATCHES = 8;
const MAX_SWEEP_ROUNDS = 4;
const active = new Set<string>();
const running = new Map<string, Promise<void>>();
const queued = new Map<string, Set<string>>();
const publicationRecovery = new Map<string, Promise<void>>();
const reclaiming = new Map<string, Promise<void>>();

type AttemptKind = 'compiler' | 'overlay' | 'validator';
type AttemptRecord = {
  version: 2;
  kind: AttemptKind;
  owner: { pid: number; startTime: string | null };
  closed: boolean;
  publication?: { device: string; inode: string };
  dataTombstone?: { device: string; inode: string };
};

export type SwiftAttempt = Readonly<{
  directory: string;
  work: string;
  data: string;
  env: NodeJS.ProcessEnv;
  record: AttemptRecord;
}>;

/** The directory compiled helpers land in for `env`: what a cached helper path is valid for. */
export function getSwiftCacheRoot(env: NodeJS.ProcessEnv): string {
  const configured = env.AGENT_DEVICE_SWIFT_CACHE_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(os.tmpdir(), 'agent-device-swift-cache');
}

/** Creates a private attempt whose name can be sealed without waiting for its children. */
export function createSwiftAttempt(env: NodeJS.ProcessEnv, kind: AttemptKind): SwiftAttempt {
  const root = getSwiftCacheRoot(env);
  const attempts = path.join(root, 'attempts');
  const pending = path.join(root, 'pending-attempts');
  fs.mkdirSync(attempts, { recursive: true });
  fs.mkdirSync(pending, { recursive: true });
  const directory = fs.mkdtempSync(path.join(attempts, `${kind}-`));
  const data = path.join(directory, 'data');
  const alias = path.join(directory, 'alias');
  fs.mkdirSync(data);
  fs.mkdirSync(alias);
  const work = path.join(alias, 'work');
  fs.symlinkSync('../data', work, 'dir');
  const home = path.join(work, 'home');
  const tmp = path.join(work, 'tmp');
  const moduleCache = path.join(work, 'module-cache');
  const xdgCache = path.join(work, 'xdg-cache');
  for (const dir of [home, tmp, moduleCache, xdgCache]) fs.mkdirSync(dir);
  const record: AttemptRecord = {
    version: 2,
    kind,
    owner: readCurrentOwnerIdentity(),
    closed: false,
  };
  writeRecord(directory, record);
  fs.writeFileSync(path.join(pending, path.basename(directory)), '', { flag: 'wx', mode: 0o600 });
  const toolEnv: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'DEVELOPER_DIR',
    'SDKROOT',
    'TOOLCHAINS',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
  ]) {
    if (env[key] !== undefined) toolEnv[key] = env[key];
  }
  Object.assign(toolEnv, {
    HOME: home,
    CFFIXED_USER_HOME: home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    XDG_CACHE_HOME: xdgCache,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    CLANG_MODULE_CACHE_PATH: moduleCache,
    SWIFT_MODULECACHE_PATH: moduleCache,
  });
  active.add(directory);
  scheduleSweep(root);
  return { directory, work, data, env: toolEnv, record };
}

/** Prevents a request environment from replacing an attempt's private writable paths. */
export async function withSwiftAttempt<T>(
  attempt: SwiftAttempt,
  run: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  return await withRestrictedCommandEnvironment({ cwd: attempt.work, env: attempt.env }, run);
}

/** Derives the publication sibling from the currently authorized video and an owned attempt. */
export function swiftPublicationPath(videoPath: string, attemptName: string): string {
  if (!ATTEMPT_NAME.test(attemptName) || !attemptName.startsWith('overlay-'))
    throw new Error('Invalid Swift overlay attempt');
  const parsed = path.parse(videoPath);
  return path.join(
    parsed.dir,
    `.${parsed.name}.agent-device-${attemptName}${parsed.ext || '.mp4'}`,
  );
}

/** Records identity only; the video path is supplied again by its owner during recovery. */
export function recordSwiftPublication(attempt: SwiftAttempt, stat: fs.BigIntStats): void {
  attempt.record.publication = { device: String(stat.dev), inode: String(stat.ino) };
  writeRecord(attempt.directory, attempt.record);
}

export async function removeSwiftPublication(
  attempt: SwiftAttempt,
  videoPath: string,
): Promise<void> {
  await unlinkMatchingPublication(videoPath, path.basename(attempt.directory), attempt.record);
}

/** Retains ownership of cleanup after the publication operation has settled. */
export function scheduleSwiftPublicationRemoval(attempt: SwiftAttempt, videoPath: string): void {
  const key = `${attempt.directory}\0${path.resolve(videoPath)}`;
  if (publicationRecovery.has(key)) return;
  const task = removeSwiftPublication(attempt, videoPath)
    .catch(() => {})
    .finally(() => {
      publicationRecovery.delete(key);
    });
  publicationRecovery.set(key, task);
}

/** Reclaims only the exact sibling named by a current video path and a verified attempt identity. */
export async function reclaimSwiftPublication(
  env: NodeJS.ProcessEnv,
  videoPath: string,
  attemptName: string,
): Promise<void> {
  if (!ATTEMPT_NAME.test(attemptName) || !attemptName.startsWith('overlay-')) return;
  if (!(await safeAttemptsRoot(getSwiftCacheRoot(env)))) return;
  const directory = path.join(getSwiftCacheRoot(env), 'attempts', attemptName);
  const record = await readRecord(directory);
  if (!record || record.kind !== 'overlay' || active.has(directory)) return;
  if (!record.closed && !(await parentGone(record.owner))) return;
  await unlinkMatchingPublication(videoPath, attemptName, record);
}

/** Runs a bounded recovery pass when the video owner supplies its path again. */
export function scheduleSwiftPublicationRecovery(env: NodeJS.ProcessEnv, videoPath: string): void {
  const root = getSwiftCacheRoot(env);
  const key = `${root}\0${path.resolve(videoPath)}`;
  if (publicationRecovery.has(key)) return;
  const task = (async () => {
    let handle: fs.Dir | undefined;
    try {
      if (!(await safeAttemptsRoot(root))) return;
      const parsed = path.parse(path.resolve(videoPath));
      const parent = await fs.promises.lstat(parsed.dir);
      if (!parent.isDirectory() || parent.isSymbolicLink()) return;
      const prefix = `.${parsed.name}.agent-device-`;
      const suffix = parsed.ext || '.mp4';
      handle = await fs.promises.opendir(parsed.dir);
      for (let count = 0; count < MAX_ENTRIES; count++) {
        const entry = await handle.read();
        if (!entry) break;
        if (
          entry.isFile() &&
          entry.name.startsWith(`${prefix}overlay-`) &&
          entry.name.endsWith(suffix)
        ) {
          const attemptName = entry.name.slice(prefix.length, -suffix.length);
          await reclaimSwiftPublication(env, videoPath, attemptName).catch(() => {});
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    } finally {
      await handle?.close();
    }
  })()
    .catch(() => {})
    .finally(() => {
      publicationRecovery.delete(key);
    });
  publicationRecovery.set(key, task);
}

async function unlinkMatchingPublication(
  videoPath: string,
  attemptName: string,
  record: AttemptRecord,
): Promise<void> {
  const identity = record.publication;
  if (!identity || !/^\d+$/.test(identity.device) || !/^\d+$/.test(identity.inode)) return;
  const target = swiftPublicationPath(videoPath, attemptName);
  try {
    const parent = await fs.promises.lstat(path.dirname(path.resolve(videoPath)));
    if (!parent.isDirectory() || parent.isSymbolicLink()) return;
    const stat = await fs.promises.lstat(target, { bigint: true });
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      String(stat.dev) !== identity.device ||
      String(stat.ino) !== identity.inode
    )
      return;
    await fs.promises.unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Seals this attempt's published pathname. Open descendants can still hold unlinked inodes. */
export function releaseSwiftAttempt(attempt: SwiftAttempt): void {
  try {
    writeRecord(attempt.directory, { ...attempt.record, closed: true });
    seal(attempt.directory);
  } finally {
    active.delete(attempt.directory);
    scheduleSweep(path.dirname(path.dirname(attempt.directory)), attempt.directory);
  }
}

function writeRecord(directory: string, record: AttemptRecord): void {
  publishFileSync({
    destination: path.join(directory, 'pending.json'),
    contents: JSON.stringify(record),
    mode: 0o600,
  });
}

function seal(directory: string): void {
  const alias = path.join(directory, 'alias');
  const aliasStat = fs.lstatSync(alias);
  if (!aliasStat.isDirectory() || aliasStat.isSymbolicLink())
    throw new Error('Invalid Swift attempt alias');
  const work = path.join(alias, 'work');
  const workStat = fs.lstatSync(work);
  if (!workStat.isSymbolicLink()) {
    if (workStat.isFile()) return;
    throw new Error('Invalid Swift attempt work path');
  }
  if (fs.readlinkSync(work) !== '../data') throw new Error('Invalid Swift attempt target');
  const tombstone = path.join(
    alias,
    `.sealed-${process.pid}-${Math.random().toString(16).slice(2)}`,
  );
  try {
    fs.writeFileSync(tombstone, '', { flag: 'wx', mode: 0o400 });
    fs.renameSync(tombstone, work);
  } finally {
    fs.rmSync(tombstone, { force: true });
  }
}

function scheduleSweep(root: string, preferred?: string): void {
  if (preferred) {
    const candidates = queued.get(root) ?? new Set<string>();
    candidates.add(preferred);
    queued.set(root, candidates);
  }
  if (running.has(root)) return;
  const next = queued.get(root)?.values().next().value as string | undefined;
  if (next) queued.get(root)?.delete(next);
  const task = sweep(root, next)
    .catch(() => {})
    .finally(() => {
      running.delete(root);
      if (queued.get(root)?.size) scheduleSweep(root);
      else queued.delete(root);
    });
  running.set(root, task);
}

async function sweep(root: string, preferred?: string): Promise<void> {
  const attempts = path.join(root, 'attempts');
  const pending = path.join(root, 'pending-attempts');
  try {
    if (!(await safeAttemptsRoot(root))) return;
    const pendingStat = await fs.promises.lstat(pending);
    if (!pendingStat.isDirectory() || pendingStat.isSymbolicLink()) return;
    for (let round = 0; round < MAX_SWEEP_ROUNDS; round++) {
      const directory = await fs.promises.opendir(pending);
      const candidates: string[] = [];
      let scanned = 0;
      try {
        if (round === 0 && preferred && path.dirname(preferred) === attempts)
          candidates.push(preferred);
        while (candidates.length < MAX_ATTEMPTS && scanned < MAX_ATTEMPTS) {
          const item = await directory.read();
          if (!item) break;
          scanned++;
          if (item.isFile() && ATTEMPT_NAME.test(item.name)) {
            const candidate = path.join(attempts, item.name);
            if (!candidates.includes(candidate)) candidates.push(candidate);
          }
        }
      } finally {
        await directory.close();
      }
      let progress = false;
      for (const candidate of candidates) {
        if (active.has(candidate)) continue;
        await reclaimOwnedCandidate(candidate).catch(() => {});
        try {
          await fs.promises.lstat(path.join(pending, path.basename(candidate)));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') progress = true;
        }
      }
      if (scanned < MAX_ATTEMPTS || !progress) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Runs one bounded cleanup pass for an exact cache-owned attempt. */
export async function reclaimSwiftAttempt(
  env: NodeJS.ProcessEnv,
  attemptName: string,
): Promise<void> {
  if (!ATTEMPT_NAME.test(attemptName)) return;
  const root = getSwiftCacheRoot(env);
  if (!(await safeAttemptsRoot(root))) return;
  const candidate = path.join(root, 'attempts', attemptName);
  if (active.has(candidate)) return;
  await reclaimOwnedCandidate(candidate);
}

function reclaimOwnedCandidate(directory: string): Promise<void> {
  const current = reclaiming.get(directory);
  if (current) return current;
  const task = (async () => {
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const result = await reclaimCandidate(directory);
      if (result === 'fenced') await removePendingEntry(directory);
      if (result !== 'more') break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  })().finally(() => {
    reclaiming.delete(directory);
  });
  reclaiming.set(directory, task);
  return task;
}

async function removePendingEntry(directory: string): Promise<void> {
  const root = path.dirname(path.dirname(directory));
  const pending = path.join(root, 'pending-attempts');
  const target = path.join(pending, path.basename(directory));
  try {
    const pendingStat = await fs.promises.lstat(pending);
    if (!pendingStat.isDirectory() || pendingStat.isSymbolicLink()) return;
    const stat = await fs.promises.lstat(target);
    if (stat.isFile() && !stat.isSymbolicLink()) await fs.promises.unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function safeAttemptsRoot(root: string): Promise<boolean> {
  try {
    const rootStat = await fs.promises.lstat(root);
    const attemptsStat = await fs.promises.lstat(path.join(root, 'attempts'));
    return (
      rootStat.isDirectory() &&
      !rootStat.isSymbolicLink() &&
      attemptsStat.isDirectory() &&
      !attemptsStat.isSymbolicLink()
    );
  } catch {
    return false;
  }
}

async function reclaimCandidate(directory: string): Promise<'retained' | 'more' | 'fenced'> {
  const record = await readRecord(directory);
  if (!record) return 'retained';
  if (!record.closed && !(await parentGone(record.owner))) return 'retained';
  try {
    seal(directory);
  } catch {
    return 'retained';
  }
  const data = path.join(directory, 'data');
  const dataStat = await fs.promises.lstat(data, { bigint: true });
  if (dataStat.isFile() && !dataStat.isSymbolicLink()) {
    const tombstone = record.dataTombstone;
    if (
      tombstone &&
      String(dataStat.dev) === tombstone.device &&
      String(dataStat.ino) === tombstone.inode
    )
      return 'fenced';
    return 'retained';
  }
  if (!dataStat.isDirectory() || dataStat.isSymbolicLink()) return 'retained';
  const handle = await fs.promises.open(
    data,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== dataStat.dev || opened.ino !== dataStat.ino || !opened.isDirectory())
      return 'retained';
    await handle.chmod(0o700);
    const budget = { remaining: MAX_ENTRIES };
    const empty = await cleanDirectory(data, budget, 0);
    if (!empty) return 'more';
    await handle.chmod(0o500);
    const check = await fs.promises.opendir(data);
    try {
      if (await check.read()) return 'more';
    } finally {
      await check.close();
    }
    try {
      await fs.promises.rmdir(data);
      const tombstone = await fs.promises.open(data, 'wx', 0o400);
      try {
        const stat = await tombstone.stat({ bigint: true });
        record.dataTombstone = { device: String(stat.dev), inode: String(stat.ino) };
        writeRecord(directory, record);
      } finally {
        await tombstone.close();
      }
      return 'fenced';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EBUSY')
        return 'more';
      throw error;
    }
  } finally {
    await handle.close();
  }
}

async function readRecord(directory: string): Promise<AttemptRecord | undefined> {
  const stat = await fs.promises.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
  const marker = path.join(directory, 'pending.json');
  const markerStat = await fs.promises.lstat(marker);
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 4096)
    return undefined;
  let record: AttemptRecord;
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(marker, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.size > 4096 ||
      opened.dev !== markerStat.dev ||
      opened.ino !== markerStat.ino
    )
      return undefined;
    record = JSON.parse(await handle.readFile('utf8')) as AttemptRecord;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
  if (!record || typeof record !== 'object') return undefined;
  if (
    record.version !== 2 ||
    !ATTEMPT_NAME.test(path.basename(directory)) ||
    !['compiler', 'overlay', 'validator'].includes(record.kind) ||
    !path.basename(directory).startsWith(`${record.kind}-`) ||
    !isProcessPid(record.owner?.pid) ||
    (record.owner.startTime !== null && typeof record.owner.startTime !== 'string') ||
    typeof record.closed !== 'boolean'
  )
    return undefined;
  return record;
}

async function parentGone(owner: AttemptRecord['owner']): Promise<boolean> {
  if (!isProcessAlive(owner.pid)) return true;
  const facts = await readProcessIdentityFacts(owner.pid);
  return (
    facts.zombie === true ||
    Boolean(owner.startTime && facts.startTime && owner.startTime !== facts.startTime)
  );
}

async function cleanDirectory(
  directory: string,
  budget: { remaining: number },
  depth: number,
): Promise<boolean> {
  if (depth > MAX_DEPTH || budget.remaining <= 0) return false;
  let handle: fs.Dir | undefined;
  let empty = true;
  try {
    handle = await fs.promises.opendir(directory);
    for (;;) {
      if (budget.remaining <= 0) return false;
      const entry = await handle.read();
      if (!entry) break;
      budget.remaining--;
      const child = path.join(directory, entry.name);
      const stat = await fs.promises.lstat(child);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        if (await cleanDirectory(child, budget, depth + 1)) {
          try {
            await fs.promises.rmdir(child);
          } catch {
            empty = false;
          }
        } else empty = false;
      } else {
        await fs.promises.unlink(child);
      }
    }
  } finally {
    await handle?.close();
  }
  return empty;
}
