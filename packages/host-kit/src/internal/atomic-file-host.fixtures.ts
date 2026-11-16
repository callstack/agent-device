// The host this suite's destinations are judged against: the directory owners a test chooses, and the
// scratch directories it builds them in. The ancestry rule reads the real host for its own identity, so a
// test that leaves that alone is asserting against whatever account the machine it runs on happens to have.

import { expect } from 'vitest';
import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';
import { publishScriptFileSync } from './atomic-file.ts';

/** This process's ids. Windows has neither, and every test that uses them is skipped there. */
export const currentUid = process.getuid?.() ?? -1;
export const currentGid = process.getgid?.() ?? -1;

/** Some other local user, not this one and not root. */
export const FOREIGN_UID = 65534;

/** A scratch root, spelled the way the kernel spells it, so a link's answer and a test's agree. */
export function ancestryRoot(): string {
  return fs.realpathSync(mkdtempForTestSync('host-kit-ancestry-'));
}

/**
 * A directory carrying `mode` and `gid`, so the rule reads the group the test chose. The group is set
 * explicitly because a scratch directory inherits one from its parent, not necessarily this user's.
 */
export function directoryWith(directory: string, mode: number, gid = currentGid): string {
  fs.mkdirSync(directory);
  fs.chownSync(directory, currentUid, gid);
  fs.chmodSync(directory, mode);
  return directory;
}

/** A publication of fixed contents, so a test says which destination and not what bytes. */
export function publish(destination: string): void {
  publishScriptFileSync({ destination, contents: 'context\n' });
}

/** Runs `run` under `process.umask(0o002)` — the umask of a shared checkout that breaks a mode-less `mkdir`. */
export function withSharedUmask(run: () => void): void {
  const previous = process.umask(0o002);
  try {
    run();
  } finally {
    process.umask(previous);
  }
}

export function expectUntrusted(run: () => void, exposure: string, ancestor: string): void {
  expectRefusal(run, 'script_ancestor_untrusted', exposure, ancestor);
}

export function expectUntrustedReplaced(run: () => void, ancestor: string): void {
  expectRefusal(run, 'script_ancestry_replaced', 'parent_replaced', ancestor);
}

/** Asserts the typed refusal a destination earns, naming the directory at fault. */
function expectRefusal(run: () => void, reason: string, exposure: string, ancestor: string): void {
  let details: Record<string, unknown> | undefined;
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    details = (error as AppError).details as Record<string, unknown>;
  }
  expect(details).toMatchObject({ reason, exposure, ancestor });
}

/** The permission bits of an entry, with the type and set-id bits cut off. */
export function modeOf(pathname: string): number {
  return fs.lstatSync(pathname).mode & 0o777;
}
