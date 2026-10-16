import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runCmdSync } from '@agent-device/host-kit/command';

export type CheckoutState = { head: string; status: string; fingerprint: string };

export function gitValue(cwd: string, args: string[]): string {
  return runCmdSync('git', args, { cwd }).stdout.trim();
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
  }).stdout;
  for (const file of untracked.split('\0').filter(Boolean).sort()) {
    const absolute = path.join(cwd, file);
    hash.update(file).update('\0');
    hash.update(
      fs.lstatSync(absolute).isSymbolicLink()
        ? fs.readlinkSync(absolute)
        : fs.readFileSync(absolute),
    );
  }
  return { head, status, fingerprint: hash.digest('hex') };
}
