// Ownership protocol for the `pnpm size --base <ref>` worktree cache.
//
// The cache is `.tmp/size-base/<sha12>/` — a detached worktree of the base commit, built once
// and reused — plus, per entry, a *claim* that says which run is currently using it. Two runs on
// one machine must never build the same entry at once, read a half-built `dist`, or delete an
// entry another run is using.
//
// A claim is a symlink whose target is the owning run's identity (`<pid>:<nonce>`):
//   - `symlink()` creates it with its identity already in place — one syscall, so there is no
//     window where a claim exists without an owner — and fails EEXIST while another run holds it.
//   - A claim whose owning pid is gone is *abandoned*. Removing one is the only dangerous step in
//     the protocol: between observing an abandoned claim and unlinking it, another run could have
//     removed it and taken the entry, and the unlink would then delete that live claim. So
//     removal happens only while holding the entry's takeover mutex — an atomically created
//     directory — and re-verifies the claim inside it. A replacement claim can appear only by
//     creating one on a free path (impossible: the abandoned claim occupies it until we unlink)
//     or by another takeover (impossible: that needs this mutex). Removal therefore cannot
//     delete a replacement.
//   - Release unlinks only a claim that still names this run, under the same mutex.
//
// The mutex protects a few syscalls with no I/O in between, so a leaked one means a process died
// inside a sub-millisecond window; one older than TAKEOVER_STALE_MS is reclaimed. Even a wrong
// reclamation is contained: two takers would both re-verify inside, at most one unlink succeeds,
// and the winner is still decided by the atomic `symlink()` that follows.

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** This run's claim identity: pid for liveness, nonce so a reused pid is still a different run. */
export const CLAIM_IDENTITY = `${process.pid}:${randomUUID()}`;

const TAKEOVER_STALE_MS = 30_000;
const CLAIM_ATTEMPTS = 8;

export function claimPath(worktreeDir) {
  return `${worktreeDir}.lock`;
}

export function takeoverPath(worktreeDir) {
  return `${worktreeDir}.takeover`;
}

/** The stamp a finished build writes; its absence means "rebuild", never "trust dist/src". */
function completionStampPath(worktreeDir) {
  return path.join(worktreeDir, 'dist', '.size-base-complete');
}

export function readClaimIdentity(claim) {
  try {
    return fs.readlinkSync(claim);
  } catch {
    return undefined;
  }
}

function pidOfIdentity(identity) {
  const pid = Number(String(identity).split(':')[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function isProcessAlive(pid) {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // exists, not signalable by us
  }
}

function tryCreateClaim(claim) {
  try {
    fs.symlinkSync(CLAIM_IDENTITY, claim);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

function enterTakeover(takeover) {
  try {
    fs.mkdirSync(takeover);
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  let age;
  try {
    age = Date.now() - fs.statSync(takeover).mtimeMs;
  } catch {
    return false; // vanished; the caller retries
  }
  if (age < TAKEOVER_STALE_MS) return false;
  try {
    fs.rmSync(takeover, { recursive: true, force: true });
    fs.mkdirSync(takeover);
    return true;
  } catch {
    return false;
  }
}

function leaveTakeover(takeover) {
  fs.rmSync(takeover, { recursive: true, force: true });
}

/**
 * Removes an abandoned claim, under the takeover mutex so it can never remove a replacement.
 * Returns what it found: 'removed' | 'gone' | 'changed' | 'live' | 'busy'.
 */
export function removeAbandonedClaim(worktreeDir, observedIdentity) {
  const claim = claimPath(worktreeDir);
  const takeover = takeoverPath(worktreeDir);
  if (!enterTakeover(takeover)) return 'busy';
  try {
    let stats;
    try {
      stats = fs.lstatSync(claim);
    } catch {
      return 'gone';
    }
    if (!stats.isSymbolicLink()) {
      // Not a claim of this scheme at all (a stray file or directory): safe to clear here.
      fs.rmSync(claim, { recursive: true, force: true });
      return 'removed';
    }
    const current = fs.readlinkSync(claim);
    if (current !== observedIdentity) return 'changed';
    if (isProcessAlive(pidOfIdentity(current))) return 'live';
    fs.unlinkSync(claim);
    return 'removed';
  } finally {
    leaveTakeover(takeover);
  }
}

function heldError(worktreeDir, holder, label) {
  const pid = pidOfIdentity(holder);
  return new Error(
    `another \`size --base\` (pid ${pid ?? 'unknown'}) is using base ${label} in ${worktreeDir}; ` +
      `wait for it, measure a different base, or remove ${claimPath(worktreeDir)} if that run is gone`,
  );
}

/**
 * Claims one cache entry for this run. Returns the release function; throws when another live
 * run holds it, or when a takeover by another run keeps the claim contended.
 */
export function acquireBaseClaim(worktreeDir, label) {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    const claim = claimPath(worktreeDir);
    if (tryCreateClaim(claim) && readClaimIdentity(claim) === CLAIM_IDENTITY) {
      return () => releaseBaseClaim(worktreeDir);
    }
    const holder = readClaimIdentity(claim);
    if (holder !== undefined && isProcessAlive(pidOfIdentity(holder))) {
      throw heldError(worktreeDir, holder, label);
    }
    const outcome = removeAbandonedClaim(worktreeDir, holder);
    if (outcome === 'live') throw heldError(worktreeDir, readClaimIdentity(claim), label);
    if (outcome === 'busy' && attempt === CLAIM_ATTEMPTS - 1) {
      throw new Error(
        `another run is taking over the abandoned claim on base ${label} in ${worktreeDir}; retry shortly`,
      );
    }
  }
  throw new Error(
    `could not claim base ${label} in ${worktreeDir} after ${CLAIM_ATTEMPTS} attempts`,
  );
}

/** Releases this run's claim; a claim that has come to name someone else is left alone. */
function releaseBaseClaim(worktreeDir) {
  const claim = claimPath(worktreeDir);
  const takeover = takeoverPath(worktreeDir);
  if (!enterTakeover(takeover)) {
    // Someone is mid-takeover of this entry; they re-verify identity, so they cannot remove ours
    // while we still own it, and our claim is removed by the next run that finds it abandoned.
    return;
  }
  try {
    if (readClaimIdentity(claim) === CLAIM_IDENTITY) fs.unlinkSync(claim);
  } finally {
    leaveTakeover(takeover);
  }
}

function removeWorktree(root, dir) {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', dir], { cwd: root, stdio: 'ignore' });
  } catch {
    // Not a registered worktree (half-created, or hand-copied): plain removal.
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Creates the entry's worktree when it is missing or unregistered; otherwise leaves it. */
function ensureBaseWorktree(root, worktreeDir, sha) {
  const registered = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
  }).includes(`worktree ${worktreeDir}\n`);
  if (registered && fs.existsSync(worktreeDir)) return;
  // Registered but gone (hand-deleted), or present but unregistered (hand-copied): start clean.
  fs.rmSync(worktreeDir, { recursive: true, force: true });
  execFileSync('git', ['worktree', 'prune'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['worktree', 'add', '--detach', worktreeDir, sha], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
  });
}

/**
 * Evicts every cache entry except `keep`, each under its own claim: an entry a live run holds is
 * skipped, and one this run evicts cannot be adopted mid-removal.
 */
function pruneOtherBaseWorktrees(root, worktreesRoot, keep) {
  const others = fs
    .readdirSync(worktreesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.endsWith('.takeover'))
    .map((entry) => path.join(worktreesRoot, entry.name))
    .filter((dir) => dir !== keep);
  for (const dir of others) {
    let release;
    try {
      release = acquireBaseClaim(dir, path.basename(dir));
    } catch {
      continue; // in use by a live run, or contended: not ours to evict
    }
    try {
      removeWorktree(root, dir);
    } finally {
      release();
    }
  }
}

/**
 * Prepares (or reuses) the cache entry for `ref` under this run's claim and hands its worktree to
 * `measure`. The install+build runs only when the entry carries no completion stamp, so an
 * interrupted build is redone rather than trusted because `dist/src` happens to exist.
 */
export function withPreparedBaseWorktree(root, ref, measure) {
  const sha = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  fs.mkdirSync(path.join(root, '.tmp', 'size-base'), { recursive: true });
  // Canonical: git lists worktrees by real path (/tmp is /private/tmp on macOS), and
  // ensureBaseWorktree compares against that listing.
  const worktreesRoot = fs.realpathSync(path.join(root, '.tmp', 'size-base'));
  const worktreeDir = path.join(worktreesRoot, sha.slice(0, 12));
  const release = acquireBaseClaim(worktreeDir, sha.slice(0, 9));
  try {
    pruneOtherBaseWorktrees(root, worktreesRoot, worktreeDir);
    ensureBaseWorktree(root, worktreeDir, sha);
    if (!fs.existsSync(completionStampPath(worktreeDir))) {
      process.stderr.write(
        `[size] measuring base ${sha.slice(0, 9)} (${ref}): install + build in ${worktreeDir}\n`,
      );
      execFileSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], {
        cwd: worktreeDir,
        stdio: ['ignore', 'ignore', 'inherit'],
      });
      execFileSync('pnpm', ['build'], { cwd: worktreeDir, stdio: ['ignore', 'ignore', 'inherit'] });
      fs.writeFileSync(completionStampPath(worktreeDir), `${sha}\n`);
    }
    return measure(worktreeDir);
  } finally {
    release();
  }
}
