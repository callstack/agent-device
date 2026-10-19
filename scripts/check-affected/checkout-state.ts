import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runCmdSync } from '@agent-device/host-kit/command';

export type CheckoutState = { head: string; status: string; fingerprint: string };

export function gitValue(cwd: string, args: string[]): string {
  return runCmdSync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }).stdout.trim();
}

export function readCheckoutState(cwd: string): CheckoutState {
  const head = gitValue(cwd, ['rev-parse', 'HEAD']);
  const status = gitValue(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
  const hash = crypto.createHash('sha256').update(head).update(status);
  for (const args of [
    ['diff', '--binary'],
    ['diff', '--binary', '--cached'],
  ]) {
    hash.update(runCmdSync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }).stdout);
  }
  const untracked = runCmdSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  }).stdout;
  for (const file of untracked.split('\0').filter(Boolean).sort())
    hashWorktreePath(hash, cwd, file);
  return { head, status, fingerprint: hash.digest('hex') };
}

function hashWorktreePath(hash: crypto.Hash, cwd: string, file: string): void {
  hash.update(file).update('\0');
  const absolute = path.join(cwd, file);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    hash.update('missing\0');
    return;
  }
  hash.update(String(stat.mode)).update('\0');
  if (stat.isDirectory()) {
    hash.update('directory\0');
    const files = runCmdSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      {
        cwd: absolute,
        maxBuffer: 64 * 1024 * 1024,
      },
    ).stdout;
    for (const child of files.split('\0').filter(Boolean).sort())
      hashWorktreePath(hash, absolute, child);
    return;
  }
  const contents = stat.isSymbolicLink() ? fs.readlinkSync(absolute) : fs.readFileSync(absolute);
  hash.update(stat.isSymbolicLink() ? 'symlink\0' : 'file\0');
  hash.update(crypto.createHash('sha256').update(contents).digest());
}
