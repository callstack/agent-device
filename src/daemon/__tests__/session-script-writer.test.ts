import { test, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HEAL_COMPLETE_SENTINEL, SessionScriptWriter } from '../session-script-writer.ts';
import { recordActionEntry } from '../session-action-recorder.ts';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';
import { parseReplayScriptDetailed } from '../../replay/script.ts';
import type { SessionAction } from '../types.ts';

function action(overrides: Partial<SessionAction> = {}): SessionAction {
  return { ts: Date.now(), command: 'click', positionals: [], flags: {}, ...overrides };
}

function writeAndParse(
  writer: SessionScriptWriter,
  session: Parameters<SessionScriptWriter['write']>[0],
) {
  const result = writer.write(session);
  if (!result.written) throw new Error('expected the script to be written');
  const script = fs.readFileSync(result.path, 'utf8');
  return { script, parsed: parseReplayScriptDetailed(script) };
}

// --- ADR 0012 decision 6, R6: the healed script is sliced from the boundary watermark ---

test('write() slices session.actions from saveScriptBoundary onward, excluding pre-watermark actions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-script-writer-boundary-'));
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const session = makeIosSession('default', {
    recordSession: true,
    saveScriptBoundary: 2,
    // Fix 2: a repair-armed write only publishes once explicitly finalized
    // (`close --save-script`) — set here to isolate THIS test's own concern
    // (boundary slicing), covered separately below.
    saveScriptComplete: true,
    actions: [
      action({ command: 'open', positionals: ['Demo'] }),
      action({ command: 'click', positionals: ['label="Old"'] }),
      action({ command: 'click', positionals: ['label="Kept 1"'] }),
      action({ command: 'click', positionals: ['label="Kept 2"'] }),
    ],
  });

  const { parsed } = writeAndParse(writer, session);
  expect(parsed.actions.map((a) => a.command)).toEqual(['click', 'click']);
  expect(parsed.actions.map((a) => a.positionals[0])).toEqual(['label="Kept 1"', 'label="Kept 2"']);
});

test('write() with no boundary set (ordinary open/close --save-script) serializes the full history, unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-script-writer-no-boundary-'));
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const session = makeIosSession('default', {
    recordSession: true,
    actions: [
      action({ command: 'open', positionals: ['Demo'] }),
      action({ command: 'click', positionals: ['label="Save"'] }),
    ],
  });

  const { parsed } = writeAndParse(writer, session);
  expect(parsed.actions.map((a) => a.command)).toEqual(['open', 'click']);
  expect(parsed.actions[0]?.positionals).toEqual(['Demo']);
  expect(parsed.actions[1]?.positionals).toEqual(['label="Save"']);
});

test('a boundary-sliced script still strips diagnostic snapshot actions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-script-writer-snapshot-strip-'));
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const session = makeIosSession('default', {
    recordSession: true,
    saveScriptBoundary: 1,
    saveScriptComplete: true,
    actions: [
      action({ command: 'open', positionals: ['Demo'] }),
      action({ command: 'snapshot', positionals: [] }),
      action({ command: 'click', positionals: ['label="Save"'] }),
    ],
  });

  const { parsed } = writeAndParse(writer, session);
  expect(parsed.actions.map((a) => a.command)).toEqual(['click']);
});

// --- ADR 0012 decision 6, R4: a REPAIR-ARMED session's writer fails loudly
// on a bare `@ref` rather than emitting it. R4 scopes this to a session that
// went through `replay --save-script` arming (`saveScriptBoundary` set) — an
// ordinary `open`/`close --save-script` recording keeps its existing
// best-effort refLabel/scoped-snapshot fallback unchanged (see the "ordinary
// recording" test below).

test('a recorded ref that resolved to a selectorChain writes a clean selector line, never the bare ref', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-script-writer-resolved-ref-'));
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const session = makeIosSession('default', {
    recordSession: true,
    saveScriptBoundary: 0,
    saveScriptComplete: true,
    actions: [
      action({
        command: 'press',
        positionals: ['@e7'],
        result: { selectorChain: ['id="save-v2"'] },
      }),
    ],
  });

  const { parsed } = writeAndParse(writer, session);
  expect(parsed.actions).toHaveLength(1);
  expect(parsed.actions[0]?.command).toBe('press');
  expect(parsed.actions[0]?.positionals).toEqual(['id="save-v2"']);
});

test('a recorded ref that never resolved to a selectorChain throws instead of emitting a bare @ref', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-script-writer-bare-ref-'));
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const session = makeIosSession('default', {
    recordSession: true,
    saveScriptBoundary: 0,
    saveScriptComplete: true,
    actions: [action({ command: 'press', positionals: ['@e7'] })],
  });

  const scriptPath = path.join(root, 'sessions', 'default', 'expected-not-written.ad');
  // BLOCKER 2: a repair commit failure is SURFACED via the result (never
  // swallowed into a bare `{written:false}`), not thrown — so close/teardown
  // can report it and keep the session for retry.
  const result = writer.write(session);
  expect(result.written).toBe(false);
  expect(result.written === false && result.error?.message).toMatch(/never resolved to a selector/);
  expect(fs.existsSync(scriptPath)).toBe(false);
  expect(fs.readdirSync(path.join(root, 'sessions')).length).toBe(0);
});

test('a bare-@ref fill action also fails loud, not just click-like commands', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-script-writer-bare-ref-fill-'));
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const session = makeIosSession('default', {
    recordSession: true,
    saveScriptBoundary: 0,
    saveScriptComplete: true,
    actions: [action({ command: 'fill', positionals: ['@e9', 'hello'] })],
  });

  const result = writer.write(session);
  expect(result.written).toBe(false);
  expect(result.written === false && result.error?.message).toMatch(/never resolved to a selector/);
});

test('a bare @ref later in the same session (after a resolved earlier action) still fails loud, writing nothing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-script-writer-partial-write-'));
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const session = makeIosSession('default', {
    recordSession: true,
    saveScriptBoundary: 0,
    saveScriptComplete: true,
    actions: [
      action({ command: 'open', positionals: ['Demo'] }),
      action({
        command: 'click',
        positionals: ['@e3'],
        result: { selectorChain: ['id="save"'] },
      }),
      action({ command: 'click', positionals: ['@e9'] }),
    ],
  });

  const result = writer.write(session);
  expect(result.written).toBe(false);
  expect(result.written === false && result.error?.message).toMatch(/never resolved to a selector/);
  expect(fs.readdirSync(path.join(root, 'sessions')).length).toBe(0);
});

test('an ordinary (non-repair-armed) recording keeps the existing bare-ref fallback, never throws', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-script-writer-ordinary-bare-ref-'),
  );
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const session = makeIosSession('default', {
    recordSession: true,
    // No saveScriptBoundary: this session was armed by plain `open`/`close
    // --save-script`, never by `replay --save-script` — R4 does not apply.
    actions: [action({ command: 'click', positionals: ['@e12'], result: { refLabel: 'Save' } })],
  });

  const { parsed } = writeAndParse(writer, session);
  // The existing scoped-snapshot + bare-ref + trailing-label fallback still
  // applies unchanged: a scoped snapshot precedes the bare ref.
  expect(parsed.actions.map((a) => a.command)).toEqual(['snapshot', 'click']);
  expect(parsed.actions[1]?.positionals[0]).toBe('@e12');
});

// --- ADR 0012 decision 6 (P2): the default `.healed.ad` sibling is never
// silently clobbered — a human must review each healed diff before promoting. ---

test('write() refuses to clobber an existing COMPLETE DEFAULT .healed.ad (no explicit --save-script=<path>)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-script-writer-clobber-'));
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const healedPath = path.join(root, 'flows', 'login.healed.ad');
  fs.mkdirSync(path.dirname(healedPath), { recursive: true });
  // A prior, unreviewed, COMPLETE healed script already sits at the default
  // sibling path (Fix 4: only a file carrying the completeness sentinel is
  // protected).
  fs.writeFileSync(
    healedPath,
    `context platform=ios device="x"\nclick id="old"\n${HEAL_COMPLETE_SENTINEL}\n`,
  );
  const before = fs.readFileSync(healedPath, 'utf8');

  const session = makeIosSession('default', {
    recordSession: true,
    saveScriptBoundary: 0,
    saveScriptComplete: true,
    saveScriptPath: healedPath,
    saveScriptDefaultedHealedPath: true,
    actions: [action({ command: 'click', positionals: ['id="new"'] })],
  });

  // BLOCKER 2c: a no-clobber refusal is surfaced via the result's error (a
  // distinct "already exists" message), not thrown; the prior complete diff is
  // untouched.
  const result = writer.write(session);
  expect(result.written).toBe(false);
  expect(result.written === false && result.error?.message).toMatch(/already exists/);
  expect(fs.readFileSync(healedPath, 'utf8')).toBe(before);
});

test('write() DOES overwrite a stale INCOMPLETE .healed.ad at the default path (Fix 4: partial is overwritable)', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-script-writer-clobber-partial-'),
  );
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const healedPath = path.join(root, 'flows', 'login.healed.ad');
  fs.mkdirSync(path.dirname(healedPath), { recursive: true });
  // A partial left over from a diverged-and-abandoned repair (pre-Fix-2 bug,
  // or any other incomplete write) — no completeness sentinel.
  fs.writeFileSync(healedPath, 'context platform=ios device="x"\nclick id="stale-partial"\n');

  const session = makeIosSession('default', {
    recordSession: true,
    saveScriptBoundary: 0,
    saveScriptComplete: true,
    saveScriptPath: healedPath,
    saveScriptDefaultedHealedPath: true,
    actions: [action({ command: 'click', positionals: ['id="new"'] })],
  });

  const result = writer.write(session);
  expect(result.written).toBe(true);
  const script = fs.readFileSync(healedPath, 'utf8');
  expect(script).toContain(HEAL_COMPLETE_SENTINEL);
  const parsed = parseReplayScriptDetailed(script);
  expect(parsed.actions.map((a) => a.positionals[0])).toEqual(['id="new"']);
});

// BLOCKER 1: the reported race is TWO writers concurrently seeing the SAME
// pre-existing PARTIAL (no-sentinel) default healed sibling and both
// classifying it as overwritable — the prior implementation then let both
// `renameSync` over it, silently, with no signal to the loser. The publish
// primitive (not the "is it complete" check) must decide exactly one winner.
test('BLOCKER 1: two writers racing on the SAME pre-existing PARTIAL target — the atomic primitive, not the incomplete check, decides exactly one winner', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-script-writer-partial-race-'));
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const healedPath = path.join(root, 'flows', 'login.healed.ad');
  fs.mkdirSync(path.dirname(healedPath), { recursive: true });
  // The shared, pre-existing PARTIAL target both writers race against — no
  // sentinel, so both writers' own completeness checks say "overwritable".
  fs.writeFileSync(healedPath, 'context platform=ios device="x"\nclick id="stale-partial"\n');

  const sessionA = makeIosSession('writer-a', {
    recordSession: true,
    saveScriptBoundary: 0,
    saveScriptComplete: true,
    saveScriptPath: healedPath,
    saveScriptDefaultedHealedPath: true,
    actions: [action({ command: 'click', positionals: ['id="from-a"'] })],
  });
  const sessionB = makeIosSession('writer-b', {
    recordSession: true,
    saveScriptBoundary: 0,
    saveScriptComplete: true,
    saveScriptPath: healedPath,
    saveScriptDefaultedHealedPath: true,
    actions: [action({ command: 'click', positionals: ['id="from-b"'] })],
  });

  // Force a genuine interleaving deterministically instead of hoping two
  // in-process calls happen to race: when writer A performs its atomic
  // "grab the existing target to inspect it" rename, run writer B's ENTIRE
  // publish to completion first — exactly the reported scenario, both
  // writers starting against the identical partial target — then let A's own
  // call proceed against whatever B left behind.
  const realRenameSync = fs.renameSync;
  let triggeredCompetingWriter = false;
  let resultB: ReturnType<SessionScriptWriter['write']> | undefined;
  const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (!triggeredCompetingWriter && from === healedPath) {
      triggeredCompetingWriter = true;
      resultB = writer.write(sessionB);
    }
    return realRenameSync(from, to);
  });

  const resultA = writer.write(sessionA);
  renameSpy.mockRestore();

  expect(resultB).toBeDefined();
  // Exactly one writer wins (publishes), the other observes a definitive
  // loss — never both silently succeeding, never a torn file caused by an
  // unconditional renameSync racing another. BLOCKER 1's follow-up fix now
  // serializes the whole decide-and-act sequence for `scriptPath` behind an
  // exclusive publish lock (see `publishNoClobberAtomically`), so the loser
  // here may fail either via the no-clobber refusal (it grabbed the target
  // and found it COMPLETE) or via lock contention (it never got a turn before
  // the winner published) — which one depends on interleaving timing, but
  // either way it is a clean, thrown loss, never a silent one.
  const outcomes = [resultA, resultB!];
  const wins = outcomes.filter((r) => r.written);
  const losses = outcomes.filter((r) => !r.written);
  expect(wins).toHaveLength(1);
  expect(losses).toHaveLength(1);
  expect(losses[0]!.written === false && losses[0]!.error?.message).toMatch(
    /already exists|timed out waiting/,
  );

  // The surviving file is exactly the winner's complete, uncorrupted script —
  // never an interleaved mix of both writers' content.
  const finalScript = fs.readFileSync(healedPath, 'utf8');
  expect(finalScript).toContain(HEAL_COMPLETE_SENTINEL);
  const parsed = parseReplayScriptDetailed(finalScript);
  const winnerLabel = resultB!.written ? 'id="from-b"' : 'id="from-a"';
  expect(parsed.actions.map((a) => a.positionals[0])).toEqual([winnerLabel]);
});

// BLOCKER 1 (follow-up): the reported race is a COMPLETE target being
// silently clobbered because the inspect/restore/publish sequence was not
// exclusive — writer A quarantines an existing COMPLETE artifact, writer B
// publishes its own COMPLETE artifact into the now-empty slot and returns
// success, and writer A's restore (`renameSync`, which replaces an existing
// destination per POSIX) then silently stomps B's freshly published bytes.
test('BLOCKER 1 (follow-up): a writer publishing while another is mid quarantine-and-restore of a COMPLETE target never gets silently clobbered', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-script-writer-complete-race-'));
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const healedPath = path.join(root, 'flows', 'login.healed.ad');
  fs.mkdirSync(path.dirname(healedPath), { recursive: true });
  // A genuine, pre-existing COMPLETE (sentinel-marked) healed artifact.
  fs.writeFileSync(
    healedPath,
    `context platform=ios device="x"\nclick id="original"\n${HEAL_COMPLETE_SENTINEL}\n`,
  );
  const before = fs.readFileSync(healedPath, 'utf8');

  const sessionA = makeIosSession('writer-a', {
    recordSession: true,
    saveScriptBoundary: 0,
    saveScriptComplete: true,
    saveScriptPath: healedPath,
    saveScriptDefaultedHealedPath: true,
    actions: [action({ command: 'click', positionals: ['id="from-a"'] })],
  });
  const sessionB = makeIosSession('writer-b', {
    recordSession: true,
    saveScriptBoundary: 0,
    saveScriptComplete: true,
    saveScriptPath: healedPath,
    saveScriptDefaultedHealedPath: true,
    actions: [action({ command: 'click', positionals: ['id="from-b"'] })],
  });

  // Force the exact interleaving the reviewer identified: let writer A's own
  // atomic "grab the existing COMPLETE target into quarantine" rename
  // actually happen (scriptPath is now momentarily empty), THEN — before A
  // restores its quarantined copy — run writer B's entire publish. Under the
  // prior implementation, B's `linkSync` won the now-empty slot and returned
  // success, only for A's subsequent restore to silently stomp B's bytes.
  const realRenameSync = fs.renameSync;
  let triggeredCompetingWriter = false;
  let resultB: ReturnType<SessionScriptWriter['write']> | undefined;
  const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    const isGrab =
      !triggeredCompetingWriter && from === healedPath && String(to).includes('.quarantine');
    if (isGrab) {
      const result = realRenameSync(from, to);
      triggeredCompetingWriter = true;
      resultB = writer.write(sessionB);
      return result;
    }
    return realRenameSync(from, to);
  });

  const resultA = writer.write(sessionA);
  renameSpy.mockRestore();

  expect(triggeredCompetingWriter).toBe(true);
  expect(resultB).toBeDefined();

  // No writer may report success unless ITS complete bytes are the ones
  // actually sitting at the target.
  const finalScript = fs.readFileSync(healedPath, 'utf8');
  if (resultA.written) expect(finalScript).toContain('id="from-a"');
  if (resultB!.written) expect(finalScript).toContain('id="from-b"');

  // A genuine COMPLETE artifact already sat at the target before either
  // writer ran: no-clobber means NEITHER may publish over it — both must be
  // refused, and the original bytes survive byte-for-byte.
  expect(resultA.written).toBe(false);
  expect(resultB!.written).toBe(false);
  expect(finalScript).toBe(before);
});

// BLOCKER 1 (lease replacement — maintainer-approved design): the PID-liveness
// `reclaimDeadLock` scheme (grab lock away -> inspect PID -> restore if live)
// was structurally race-prone: a three-writer interleaving let waiter A
// rename waiter B's now-LIVE lock away (to inspect it), waiter C `linkSync`
// its own lock into the momentarily-empty path, then A's "restore"
// (`renameSync`, which replaces an existing destination) silently clobbered
// C's freshly acquired lock — and the pathname-based release could then
// remove a SUCCESSOR's lock, not the caller's own. Replaced with a TTL LEASE:
// staleness is judged purely from a timestamp embedded in the lock file's own
// content (never by asking the OS whether a PID is alive), a stolen lease is
// NEVER restored (an unconditional discard after a single atomic rename), and
// every publish verifies it STILL owns the lease immediately before entering
// the critical section — closing the window where the lock FILE could be
// contended out from under a legitimate holder.

test('BLOCKER 1 (lease): a FRESH lease is never stolen regardless of its recorded owner — staleness is judged purely by age — and a contender backs off and times out', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-script-writer-lease-fresh-'));
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const healedPath = path.join(root, 'flows', 'login.healed.ad');
  fs.mkdirSync(path.dirname(healedPath), { recursive: true });
  const originalContent = 'context platform=ios device="x"\nclick id="stale-partial"\n';
  fs.writeFileSync(healedPath, originalContent);

  const lockPath = `${healedPath}.lock`;
  // A lease recorded under a pid that could never be a real, running
  // process — the OLD PID-liveness scheme would have judged this "dead" on
  // sight and reclaimed it. The lease scheme must never steal it: it is
  // FRESH (just created), and staleness is judged purely by age now, never
  // by asking the OS whether a pid is alive.
  const freshToken = `999999999:unrelated-writer:${Date.now()}`;
  fs.writeFileSync(lockPath, freshToken);

  const session = makeIosSession('default', {
    recordSession: true,
    saveScriptBoundary: 0,
    saveScriptComplete: true,
    saveScriptPath: healedPath,
    saveScriptDefaultedHealedPath: true,
    actions: [action({ command: 'click', positionals: ['id="new"'] })],
  });

  const result = writer.write(session);
  expect(result.written).toBe(false);
  expect(result.written === false && result.error?.message).toMatch(/timed out waiting/);
  // The fresh lease survives byte-for-byte — never renamed/removed.
  expect(fs.readFileSync(lockPath, 'utf8')).toBe(freshToken);
  // The contender never entered the critical section.
  expect(fs.readFileSync(healedPath, 'utf8')).toBe(originalContent);
});

test('BLOCKER 1 (lease): an EXPIRED lease is stolen safely — never restored — and a fresh reclaim afterward publishes cleanly', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-script-writer-lease-expired-'));
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const healedPath = path.join(root, 'flows', 'login.healed.ad');
  fs.mkdirSync(path.dirname(healedPath), { recursive: true });
  fs.writeFileSync(healedPath, 'context platform=ios device="x"\nclick id="stale-partial"\n');

  const lockPath = `${healedPath}.lock`;
  // A crashed writer's abandoned lease: older than LEASE_TTL_MS (30_000ms).
  fs.writeFileSync(lockPath, `424242:crashed-writer:${Date.now() - 31_000}`);

  const session = makeIosSession('default', {
    recordSession: true,
    saveScriptBoundary: 0,
    saveScriptComplete: true,
    saveScriptPath: healedPath,
    saveScriptDefaultedHealedPath: true,
    actions: [action({ command: 'click', positionals: ['id="new"'] })],
  });

  const result = writer.write(session);
  expect(result.written).toBe(true);
  // The expired lease was stolen and released again — no lock file lingers.
  expect(fs.existsSync(lockPath)).toBe(false);
  const script = fs.readFileSync(healedPath, 'utf8');
  expect(script).toContain(HEAL_COMPLETE_SENTINEL);
  expect(parseReplayScriptDetailed(script).actions.map((a) => a.positionals[0])).toEqual([
    'id="new"',
  ]);
});

// BLOCKER 1 (lease, three-writer interleaving — the reviewer's exact missing
// case): during ANY reclaim window, a third writer C can validly acquire and
// enter the critical section. Assert: (1) exactly one holder is EVER in the
// critical section for a given moment — a writer whose lease gets displaced
// underneath it (B) is never fooled into proceeding unprotected, because
// `verifyOwnership` re-checks immediately before the critical section; (2) a
// displaced writer's OWN release never deletes its successor's (A's) lock —
// release is strictly token-scoped; (3) the discarding writer (A) never
// performs a destination-replacing "restore" — a live claim it accidentally
// grabbed is discarded outright, never renamed back over whoever now holds
// the path, so a genuinely fresh writer (C) can subsequently acquire and
// publish cleanly once the lock is free.
test('BLOCKER 1 (lease, three-writer interleaving): a stale steal decision can never let two writers enter the critical section at once, and release never deletes a successor lock', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-script-writer-lease-three-writer-'),
  );
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const healedPath = path.join(root, 'flows', 'login.healed.ad');
  fs.mkdirSync(path.dirname(healedPath), { recursive: true });
  const originalContent = 'context platform=ios device="x"\nclick id="stale-partial"\n';
  fs.writeFileSync(healedPath, originalContent);

  const lockPath = `${healedPath}.lock`;
  // Writer X crashed, leaving an abandoned, genuinely EXPIRED lease — both A
  // and B will independently decide (correctly, at the time each reads it)
  // that this is stealable.
  fs.writeFileSync(lockPath, `111111:x-writer-token:${Date.now() - 31_000}`);

  const sessionB = makeIosSession('writer-b', {
    recordSession: true,
    saveScriptBoundary: 0,
    saveScriptComplete: true,
    saveScriptPath: healedPath,
    saveScriptDefaultedHealedPath: true,
    actions: [action({ command: 'click', positionals: ['id="from-b"'] })],
  });

  // Deterministically drive the exact interleaving: right after WRITER B's
  // own claim (`linkSync`) legitimately WINS the now-freed `lockPath` (B has
  // just, validly, re-acquired a FRESH lease and is about to verify
  // ownership and publish) — inject WRITER A independently grabbing
  // whatever CURRENTLY sits at `lockPath`. A's own decision to steal was
  // made from an EARLIER read of X's now-superseded dead lease — but a
  // rename operates on whatever is there NOW, not on the bytes A read
  // earlier, so A's grab unavoidably catches B's fresh claim instead of X's.
  // A discards it outright (never a restore) and re-claims fresh as its own
  // — using the exact same primitives the real implementation uses.
  const realLinkSync = fs.linkSync;
  let injected = false;
  const aToken = `222222:a-writer-token:${Date.now()}`;
  let lockContentDuringInjection: string | undefined;
  const linkSpy = vi
    .spyOn(fs, 'linkSync')
    .mockImplementation((existingPath: fs.PathLike, newPath: fs.PathLike) => {
      let thrown: unknown;
      try {
        realLinkSync(existingPath, newPath);
      } catch (error) {
        thrown = error;
      }
      if (!thrown && !injected && newPath === lockPath) {
        injected = true;
        const aQuarantine = `${lockPath}.a-writer.quarantine`;
        fs.renameSync(lockPath, aQuarantine); // A's grab — catches B's fresh claim, not X's.
        fs.rmSync(aQuarantine, { force: true }); // Unconditional discard — never a restore.
        const aTemp = `${lockPath}.a-writer.tmp`;
        fs.writeFileSync(aTemp, aToken);
        fs.linkSync(aTemp, lockPath); // A's own fresh re-claim.
        fs.rmSync(aTemp, { force: true });
        lockContentDuringInjection = fs.readFileSync(lockPath, 'utf8');
      }
      if (thrown) throw thrown;
    });

  const resultB = writer.write(sessionB);
  linkSpy.mockRestore();

  expect(injected).toBe(true);
  // A's re-claim was its OWN fresh token — never B's trampled one restored
  // back verbatim (that would be the forbidden clobbering "restore" shape).
  expect(lockContentDuringInjection).toBe(aToken);
  // (1) B's fresh claim was displaced underneath it, but B is never fooled
  // into proceeding unprotected: `verifyOwnership` catches the mismatch
  // immediately before the critical section, so B safely aborts instead of
  // silently entering it alongside anyone else.
  expect(resultB.written).toBe(false);
  expect(resultB.written === false && resultB.error?.message).toMatch(/lease/);
  // scriptPath is untouched — B never reached the critical section, so it
  // never got the chance to publish or corrupt it.
  expect(fs.readFileSync(healedPath, 'utf8')).toBe(originalContent);
  // (2) B's own `finally` release ran as it unwound from the throw — it
  // must NOT have deleted A's now-current lock: release is strictly
  // token-scoped (B's token no longer matches what's actually there).
  expect(fs.readFileSync(lockPath, 'utf8')).toBe(aToken);

  // A eventually releases (as any real holder would), and a genuinely fresh
  // writer C can then cleanly acquire and publish — (3) exactly ONE holder
  // (C) ever actually ends up in the critical section for this scriptPath.
  fs.rmSync(lockPath, { force: true });
  const sessionC = makeIosSession('writer-c', {
    recordSession: true,
    saveScriptBoundary: 0,
    saveScriptComplete: true,
    saveScriptPath: healedPath,
    saveScriptDefaultedHealedPath: true,
    actions: [action({ command: 'click', positionals: ['id="from-c"'] })],
  });
  const resultC = writer.write(sessionC);
  expect(resultC.written).toBe(true);
  const finalScript = fs.readFileSync(healedPath, 'utf8');
  expect(finalScript).toContain(HEAL_COMPLETE_SENTINEL);
  expect(parseReplayScriptDetailed(finalScript).actions.map((a) => a.positionals[0])).toEqual([
    'id="from-c"',
  ]);
  // No lock file lingers once C's publish (and release) completes.
  expect(fs.existsSync(lockPath)).toBe(false);
});

// BLOCKER 4: the no-clobber, complete-artifact protection must apply to an
// EXPLICIT `--save-script=<path>` target too, not just the default healed
// sibling — an explicit target is caller-DIRECTED (which path to use), never
// caller-AUTHORIZED to silently destroy an unreviewed prior COMPLETE healed
// diff sitting there.
test('BLOCKER 4: write() refuses to clobber an existing COMPLETE artifact at an EXPLICIT --save-script=<path> target too', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-script-writer-explicit-complete-clobber-'),
  );
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const explicitOut = path.join(root, 'flows', 'promoted.ad');
  fs.mkdirSync(path.dirname(explicitOut), { recursive: true });
  fs.writeFileSync(
    explicitOut,
    `context platform=ios device="x"\nclick id="old"\n${HEAL_COMPLETE_SENTINEL}\n`,
  );
  const before = fs.readFileSync(explicitOut, 'utf8');

  const session = makeIosSession('default', {
    recordSession: true,
    saveScriptBoundary: 0,
    saveScriptComplete: true,
    saveScriptPath: explicitOut,
    // No saveScriptDefaultedHealedPath: this is an explicit, caller-directed
    // target — the protection must apply here too, not just the default path.
    actions: [action({ command: 'click', positionals: ['id="new"'] })],
  });

  const result = writer.write(session);
  expect(result.written).toBe(false);
  expect(result.written === false && result.error?.message).toMatch(/already exists/);
  // The prior complete diff at the explicit target is untouched.
  expect(fs.readFileSync(explicitOut, 'utf8')).toBe(before);
});

test('write() DOES overwrite when the caller passed an explicit --save-script=<path> (not defaulted)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-script-writer-explicit-out-'));
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const outPath = path.join(root, 'flows', 'explicit.ad');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, 'context platform=ios device="x"\nclick id="old"\n');

  const session = makeIosSession('default', {
    recordSession: true,
    saveScriptBoundary: 0,
    saveScriptComplete: true,
    saveScriptPath: outPath,
    // No saveScriptDefaultedHealedPath: the caller directed this path explicitly.
    actions: [action({ command: 'click', positionals: ['id="new"'] })],
  });

  const result = writer.write(session);
  expect(result.written).toBe(true);
  const parsed = parseReplayScriptDetailed(fs.readFileSync(outPath, 'utf8'));
  expect(parsed.actions.map((a) => a.positionals[0])).toEqual(['id="new"']);
});

test('close --save-script=<explicit path> clears the defaulted marker, so an explicit overwrite of an existing file SUCCEEDS', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-script-writer-close-explicit-'));
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const defaultedHealed = path.join(root, 'flows', 'login.healed.ad');
  const explicitOut = path.join(root, 'flows', 'promoted.ad');
  fs.mkdirSync(path.dirname(explicitOut), { recursive: true });
  fs.writeFileSync(explicitOut, 'context platform=ios device="x"\nclick id="old"\n');

  // The repair defaulted to `.healed.ad` (marker set).
  const session = makeIosSession('default', {
    recordSession: true,
    saveScriptBoundary: 0,
    saveScriptPath: defaultedHealed,
    saveScriptDefaultedHealedPath: true,
    actions: [action({ command: 'click', positionals: ['id="new"'] })],
  });

  // `close --save-script=<explicit existing path>` re-points the path AND
  // clears the marker (regression: it used to retain the marker and wrongly
  // refuse the explicit overwrite).
  recordActionEntry(session, {
    command: 'close',
    positionals: [],
    flags: { saveScript: explicitOut },
  });
  expect(session.saveScriptDefaultedHealedPath).toBe(false);
  expect(session.saveScriptPath).toBe(explicitOut);
  // `recordActionEntry` is the low-level action recorder `close`'s handler
  // calls on its way to setting the finalize signal (Fix 2) — set here to
  // isolate this test's own concern (defaulted-marker clearing).
  session.saveScriptComplete = true;

  const result = writer.write(session);
  expect(result.written).toBe(true);
  expect(result.written && result.path).toBe(explicitOut);
  const parsed = parseReplayScriptDetailed(fs.readFileSync(explicitOut, 'utf8'));
  expect(parsed.actions.some((a) => a.positionals[0] === 'id="new"')).toBe(true);
});

// --- ADR 0012 decision 6, R7 + commit semantics (Fix 2, C2): a repair-armed
// write COMMITS only when the transaction is COMPLETE (ARMED -> COMPLETE ->
// COMMITTED); an incomplete transaction ABORTS (publishes no prefix), and a
// committed one is an idempotent no-op. ---

test('C2 abort-before-complete: a repair-armed but NOT-complete write discards — no file, no prefix', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-script-writer-incomplete-'));
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const session = makeIosSession('default', {
    recordSession: true,
    saveScriptBoundary: 0,
    // No saveScriptComplete: the plan never ran to its last executable step
    // (a `close`/`close --save-script` reached after a divergence, a daemon
    // teardown, or an idle-reap of an in-flight repair).
    actions: [action({ command: 'click', positionals: ['id="save"'] })],
  });

  const result = writer.write(session);
  expect(result).toEqual({ written: false });
  expect(fs.existsSync(path.join(root, 'sessions'))).toBe(false);
  // Not committed — teardown will tombstone it (C5a).
  expect(session.saveScriptCommitted).toBeFalsy();
});

test('C2 commit-when-complete: a repair-armed COMPLETE write publishes and marks the session COMMITTED', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-script-writer-complete-'));
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const outPath = path.join(root, 'flows', 'flow.healed.ad');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const session = makeIosSession('default', {
    recordSession: true,
    saveScriptBoundary: 0,
    saveScriptComplete: true,
    saveScriptPath: outPath,
    actions: [action({ command: 'click', positionals: ['id="save"'] })],
  });

  const result = writer.write(session);
  expect(result.written).toBe(true);
  expect(fs.readFileSync(outPath, 'utf8')).toContain(HEAL_COMPLETE_SENTINEL);
  expect(session.saveScriptCommitted).toBe(true);
});

test('C2 idempotent post-commit: a second write on a COMMITTED session no-ops (no re-publish, no error)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-script-writer-idempotent-'));
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const outPath = path.join(root, 'flows', 'flow.healed.ad');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const session = makeIosSession('default', {
    recordSession: true,
    saveScriptBoundary: 0,
    saveScriptComplete: true,
    saveScriptPath: outPath,
    actions: [action({ command: 'click', positionals: ['id="save"'] })],
  });

  expect(writer.write(session).written).toBe(true);
  const firstContent = fs.readFileSync(outPath, 'utf8');
  const firstMtime = fs.statSync(outPath).mtimeMs;

  // Mutate actions to prove a re-publish WOULD change the file if it happened.
  session.actions.push(action({ command: 'click', positionals: ['id="other"'] }));
  const second = writer.write(session);
  expect(second).toEqual({ written: false });
  // The published artifact is untouched — the committed transaction never
  // re-writes (no duplicate, no corruption).
  expect(fs.readFileSync(outPath, 'utf8')).toBe(firstContent);
  expect(fs.statSync(outPath).mtimeMs).toBe(firstMtime);
});

test('write() still emits an ordinary (non-repair) recording on close without --save-script, unaffected by the commit gate', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-script-writer-ordinary-unfinalized-'),
  );
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const session = makeIosSession('default', {
    recordSession: true,
    // No saveScriptBoundary: an ordinary `open --save-script` recording, not
    // a repair — the Fix 2 gate only applies to repair-armed sessions.
    actions: [action({ command: 'click', positionals: ['id="save"'] })],
  });

  const { parsed } = writeAndParse(writer, session);
  expect(parsed.actions.map((a) => a.command)).toEqual(['click']);
});

test('write() never appends the completeness sentinel to an ordinary (non-repair) recording', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-script-writer-no-sentinel-'));
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const session = makeIosSession('default', {
    recordSession: true,
    actions: [action({ command: 'click', positionals: ['id="save"'] })],
  });

  const { script } = writeAndParse(writer, session);
  expect(script).not.toContain(HEAL_COMPLETE_SENTINEL);
});

test('write() publishes atomically: no stray temp file survives a successful repair write', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-script-writer-atomic-'));
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const outPath = path.join(root, 'flows', 'atomic.healed.ad');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const session = makeIosSession('default', {
    recordSession: true,
    saveScriptBoundary: 0,
    saveScriptComplete: true,
    saveScriptPath: outPath,
    actions: [action({ command: 'click', positionals: ['id="save"'] })],
  });

  const result = writer.write(session);
  expect(result.written).toBe(true);
  // The only file left in the destination directory is the published script
  // itself — the temp path was renamed into place, not left behind.
  expect(fs.readdirSync(path.dirname(outPath))).toEqual([path.basename(outPath)]);
  expect(fs.readFileSync(outPath, 'utf8')).toContain(HEAL_COMPLETE_SENTINEL);
});
