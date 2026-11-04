import fs from 'node:fs';
import path from 'node:path';
import { createSwiftAttempt, releaseSwiftAttempt } from '../../swift-attempt.ts';

const [root, boundary] = process.argv.slice(2);
if (!root || !boundary) throw new Error('missing fixture arguments');
const env = {
  ...process.env,
  AGENT_DEVICE_SWIFT_CACHE_DIR: path.join(root, 'cache'),
  AGENT_DEVICE_CLAIMS_DIR: path.join(root, 'claims'),
};
const attempt = createSwiftAttempt(env, 'compiler');
const originalRmdir = fs.promises.rmdir;
const originalOpen = fs.promises.open;
const originalLink = fs.promises.link;
fs.promises.rmdir = async (...args) => {
  await originalRmdir(...args);
  if (boundary === 'rmdir' && args[0] === attempt.data) {
    process.stdout.write(`${JSON.stringify({ checkpoint: 'rmdir' })}\n`);
    await new Promise<void>(() => {});
  }
};
fs.promises.open = (async (...args: Parameters<typeof originalOpen>) => {
  const handle = await originalOpen(...args);
  if (boundary === 'create' && args[0] === path.join(attempt.data, '.data-fence')) {
    process.stdout.write(`${JSON.stringify({ checkpoint: 'create' })}\n`);
    await new Promise<void>(() => {});
  }
  return handle;
}) as typeof originalOpen;
fs.promises.link = async (...args) => {
  if (boundary === 'journal' && args[1] === path.join(attempt.directory, 'data-fence')) {
    process.stdout.write(`${JSON.stringify({ checkpoint: 'journal' })}\n`);
    await new Promise<void>(() => {});
  }
  await originalLink(...args);
  if (boundary === 'install' && args[1] === attempt.data) {
    process.stdout.write(`${JSON.stringify({ checkpoint: 'install' })}\n`);
    await new Promise<void>(() => {});
  }
};
process.stdout.write(
  `${JSON.stringify({ attempt: path.basename(attempt.directory), data: attempt.data })}\n`,
);
await new Promise<void>((resolve) => {
  const timer = setInterval(() => {
    if (fs.existsSync(path.join(root, 'begin'))) {
      clearInterval(timer);
      resolve();
    }
  }, 10);
});
await releaseSwiftAttempt(attempt);
await new Promise<void>(() => {});
