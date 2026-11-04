import fs from 'node:fs';
import path from 'node:path';
import {
  createSwiftAttempt,
  reclaimSwiftAttempt,
  releaseSwiftAttempt,
} from '../../swift-attempt.ts';

const [root, role, attemptName] = process.argv.slice(2);
if (!root || !role) throw new Error('missing fixture arguments');
const env = {
  ...process.env,
  AGENT_DEVICE_CLAIMS_DIR: path.join(root, 'claims'),
  AGENT_DEVICE_SWIFT_CACHE_DIR: path.join(root, 'cache'),
};
const file = (name: string) => path.join(root, name);
const write = (name: string, data: unknown) => fs.writeFileSync(file(name), JSON.stringify(data));
async function wait(name: string): Promise<void> {
  const until = Date.now() + 15000;
  while (!fs.existsSync(file(name))) {
    if (Date.now() >= until) throw new Error(`fixture timed out: ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

if (role === 'owner') {
  const originalOpen = fs.promises.opendir;
  fs.promises.opendir = (async (...args: Parameters<typeof originalOpen>) => {
    const dir = await originalOpen(...args);
    if (args[0] === path.join(root, 'cache', 'pending-attempts')) {
      const close = dir.close.bind(dir);
      dir.close = (async () => {
        await close();
        write('sweep-closed', true);
      }) as typeof dir.close;
    }
    return dir;
  }) as typeof originalOpen;
  const attempt = createSwiftAttempt(env, 'compiler');
  write('owner-ready', { attempt: path.basename(attempt.directory), data: attempt.data });
  await wait('owner-go');
  const rename = fs.renameSync;
  let injected = false;
  fs.renameSync = ((from, to) => {
    if (!injected && to === attempt.work) {
      injected = true;
      throw Object.assign(new Error('fixture'), { code: 'EIO' });
    }
    return rename(from, to);
  }) as typeof fs.renameSync;
  try {
    await releaseSwiftAttempt(attempt);
    throw new Error('seal unexpectedly succeeded');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EIO') throw error;
    write('owner-failed', { code: (error as NodeJS.ErrnoException).code });
  } finally {
    fs.renameSync = rename;
  }
  await wait('owner-retry');
  await releaseSwiftAttempt(attempt);
  write(
    'owner-retried',
    JSON.parse(fs.readFileSync(path.join(attempt.directory, 'pending.json'), 'utf8')),
  );
  await wait('owner-done');
} else {
  if (!attemptName) throw new Error('missing attempt');
  const directory = path.join(root, 'cache', 'attempts', attemptName);
  if (role === 'first') {
    const originalOpen = fs.promises.opendir;
    let paused = false;
    fs.promises.opendir = (async (...args: Parameters<typeof originalOpen>) => {
      const dir = await originalOpen(...args);
      if (!paused && args[0] === path.join(directory, 'data')) {
        paused = true;
        write('first-holding', true);
        await wait('first-go');
      }
      return dir;
    }) as typeof originalOpen;
    write('first-ready', true);
    await wait('first-start');
    write('first-result', await reclaimSwiftAttempt(env, attemptName));
  } else if (role === 'second') {
    write('second-ready', true);
    await wait('second-start');
    write('second-result', await reclaimSwiftAttempt(env, attemptName));
    await wait('second-retry');
    write('second-retried', await reclaimSwiftAttempt(env, attemptName));
  } else throw new Error('unknown fixture role');
}
