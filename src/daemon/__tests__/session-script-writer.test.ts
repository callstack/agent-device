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
// silently clobbered — a human must review each healed diff before promoting.
// The publish primitive refuses ANY pre-existing target, complete or
// partial, uniformly (no lock, no lease, no overwrite). ---

// (a) publishing to an ABSENT target succeeds.
test('write() publishes cleanly when the target does not exist yet', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-script-writer-absent-'));
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const healedPath = path.join(root, 'flows', 'login.healed.ad');

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
  expect(result.written && result.path).toBe(healedPath);
  const script = fs.readFileSync(healedPath, 'utf8');
  expect(script).toContain(HEAL_COMPLETE_SENTINEL);
  const parsed = parseReplayScriptDetailed(script);
  expect(parsed.actions.map((a) => a.positionals[0])).toEqual(['id="new"']);
});

// (b) publishing when a COMPLETE sentinel-marked artifact exists is REFUSED,
// bytes unchanged.
test('write() refuses to clobber an existing COMPLETE DEFAULT .healed.ad', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-script-writer-clobber-'));
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const healedPath = path.join(root, 'flows', 'login.healed.ad');
  fs.mkdirSync(path.dirname(healedPath), { recursive: true });
  // A prior, unreviewed, COMPLETE healed script already sits at the default
  // sibling path — the publish primitive refuses ANY pre-existing target, so
  // this is refused regardless of the sentinel.
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

test('write() now refuses to clobber a stale PARTIAL (non-sentinel) .healed.ad at the default path too (behavior change: no more auto-overwrite)', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-script-writer-clobber-partial-'),
  );
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const healedPath = path.join(root, 'flows', 'login.healed.ad');
  fs.mkdirSync(path.dirname(healedPath), { recursive: true });
  // A partial left over from a diverged-and-abandoned repair (pre-Fix-2 bug,
  // or any other incomplete write) — no completeness sentinel. The lock/lease
  // machinery used to distinguish this from a COMPLETE artifact and silently
  // overwrite it; the simplified publish primitive refuses ANY pre-existing
  // target uniformly, complete or partial alike.
  fs.writeFileSync(healedPath, 'context platform=ios device="x"\nclick id="stale-partial"\n');
  const before = fs.readFileSync(healedPath, 'utf8');

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
  expect(result.written === false && result.error?.message).toMatch(/already exists/);
  expect(fs.readFileSync(healedPath, 'utf8')).toBe(before);
});

// --- #1258: `--force`/`--overwrite` opts into replacing an existing target
// atomically instead of refusing. ---

test('write(session, { force: true }) overwrites an existing COMPLETE target atomically', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-script-writer-force-'));
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const healedPath = path.join(root, 'flows', 'login.healed.ad');
  fs.mkdirSync(path.dirname(healedPath), { recursive: true });
  fs.writeFileSync(
    healedPath,
    `context platform=ios device="x"\nclick id="old"\n${HEAL_COMPLETE_SENTINEL}\n`,
  );

  const session = makeIosSession('default', {
    recordSession: true,
    saveScriptBoundary: 0,
    saveScriptComplete: true,
    saveScriptPath: healedPath,
    saveScriptDefaultedHealedPath: true,
    actions: [action({ command: 'click', positionals: ['id="new"'] })],
  });

  const result = writer.write(session, { force: true });
  expect(result.written).toBe(true);
  expect(result.written && result.path).toBe(healedPath);
  const parsed = parseReplayScriptDetailed(fs.readFileSync(healedPath, 'utf8'));
  expect(parsed.actions.map((a) => a.positionals[0])).toEqual(['id="new"']);
  // The overwrite is atomic (rename-replace): only the published target
  // remains in the directory, no stray temp file left behind.
  expect(fs.readdirSync(path.dirname(healedPath))).toEqual([path.basename(healedPath)]);
});

test('write(session, { force: true }) overwrites an existing target for ORDINARY (non-repair) recording too', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-script-writer-force-ordinary-'));
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const outPath = path.join(root, 'flows', 'existing.ad');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, 'context platform=ios device="x"\nclick id="old"\n');

  const session = makeIosSession('default', {
    recordSession: true,
    // No saveScriptBoundary: ordinary open/close --save-script, not a repair.
    saveScriptPath: outPath,
    actions: [action({ command: 'click', positionals: ['id="new"'] })],
  });

  const result = writer.write(session, { force: true });
  expect(result.written).toBe(true);
  const parsed = parseReplayScriptDetailed(fs.readFileSync(outPath, 'utf8'));
  expect(parsed.actions.map((a) => a.positionals[0])).toEqual(['id="new"']);
});

test('write(session) without { force: true } still refuses, even when a prior write in the same test used force', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-script-writer-force-default-'));
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const outPath = path.join(root, 'flows', 'existing.ad');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, 'context platform=ios device="x"\nclick id="old"\n');
  const before = fs.readFileSync(outPath, 'utf8');

  const session = makeIosSession('default', {
    recordSession: true,
    saveScriptPath: outPath,
    actions: [action({ command: 'click', positionals: ['id="new"'] })],
  });

  // Default (no options / force omitted): refuse-on-exist, unchanged.
  expect(() => writer.write(session)).toThrow(/already exists/);
  expect(fs.readFileSync(outPath, 'utf8')).toBe(before);
});

// The lock/lease machinery previously here (acquireLease/releaseLease/
// stealExpiredLease/the three-writer interleaving) is gone: the publish
// primitive is now a single exclusive `linkSync`, which already decides a
// concurrent race correctly without any lock — first writer wins, the loser
// sees `EEXIST` and is refused.
test('two writers racing on the SAME ABSENT target: exactly one linkSync wins, the other is refused (no lock involved)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-script-writer-race-'));
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const healedPath = path.join(root, 'flows', 'login.healed.ad');
  fs.mkdirSync(path.dirname(healedPath), { recursive: true });

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

  // Force a genuine interleaving deterministically: just before writer A's
  // own final `linkSync` into `healedPath` runs, drive writer B's ENTIRE
  // publish to completion first — both writers started against the same
  // absent target, but B's own `linkSync` gets there first.
  const realLinkSync = fs.linkSync;
  let triggeredCompetingWriter = false;
  let resultB: ReturnType<SessionScriptWriter['write']> | undefined;
  const linkSpy = vi
    .spyOn(fs, 'linkSync')
    .mockImplementation((existingPath: fs.PathLike, newPath: fs.PathLike) => {
      if (!triggeredCompetingWriter && newPath === healedPath) {
        triggeredCompetingWriter = true;
        resultB = writer.write(sessionB);
      }
      return realLinkSync(existingPath, newPath);
    });

  const resultA = writer.write(sessionA);
  linkSpy.mockRestore();

  expect(resultB).toBeDefined();
  // Exactly one writer wins (its own linkSync creates the file), the other's
  // subsequent linkSync sees EEXIST and is cleanly refused — never both
  // silently succeeding, never a torn/mixed file.
  const outcomes = [resultA, resultB!];
  const wins = outcomes.filter((r) => r.written);
  const losses = outcomes.filter((r) => !r.written);
  expect(wins).toHaveLength(1);
  expect(losses).toHaveLength(1);
  expect(losses[0]!.written === false && losses[0]!.error?.message).toMatch(/already exists/);

  const finalScript = fs.readFileSync(healedPath, 'utf8');
  expect(finalScript).toContain(HEAL_COMPLETE_SENTINEL);
  const parsed = parseReplayScriptDetailed(finalScript);
  const winnerLabel = resultB!.written ? 'id="from-b"' : 'id="from-a"';
  expect(parsed.actions.map((a) => a.positionals[0])).toEqual([winnerLabel]);
});

// BLOCKER 4: the no-clobber protection applies to an EXPLICIT
// `--save-script=<path>` target identically to the default healed sibling —
// an explicit target is caller-DIRECTED (which path to use), never
// caller-AUTHORIZED to silently destroy an unreviewed prior healed diff
// sitting there.
test('write() refuses to clobber an existing COMPLETE artifact at an EXPLICIT --save-script=<path> target too', () => {
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

// (d) an explicit --save-script=<path> to an existing file is REFUSED
// identically to the default path — behavior change: this used to succeed
// (a non-sentinel/partial file was freely overwritable at an explicit path).
test('write() now refuses an explicit --save-script=<path> pointing at an existing (non-sentinel) file too', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-script-writer-explicit-out-'));
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const outPath = path.join(root, 'flows', 'explicit.ad');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, 'context platform=ios device="x"\nclick id="old"\n');
  const before = fs.readFileSync(outPath, 'utf8');

  const session = makeIosSession('default', {
    recordSession: true,
    saveScriptBoundary: 0,
    saveScriptComplete: true,
    saveScriptPath: outPath,
    // No saveScriptDefaultedHealedPath: the caller directed this path explicitly.
    actions: [action({ command: 'click', positionals: ['id="new"'] })],
  });

  const result = writer.write(session);
  expect(result.written).toBe(false);
  expect(result.written === false && result.error?.message).toMatch(/already exists/);
  expect(fs.readFileSync(outPath, 'utf8')).toBe(before);
});

// (e) the refuse-on-exist publish primitive is shared with ORDINARY
// (non-repair) recording too — no `saveScriptBoundary` at all, i.e. a plain
// `open --save-script`/`close --save-script` session, never `replay
// --save-script`. Before the maintainer-approved uniform simplification,
// this path published via a separate atomic rename-replace and silently
// overwrote an existing target; that overwrite path is gone (see the ADR's
// "Scope" note under decision 6). This is the coverage gap the reviewer
// flagged on #1235: only repair-armed (`saveScriptBoundary` set, even to 0)
// sessions were exercised above.
test('an ordinary (non-repair) recording now refuses an existing target too (behavior change: no more rename-replace overwrite)', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-script-writer-ordinary-clobber-'),
  );
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const outPath = path.join(root, 'flows', 'existing.ad');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, 'context platform=ios device="x"\nclick id="old"\n');
  const before = fs.readFileSync(outPath, 'utf8');

  const session = makeIosSession('default', {
    recordSession: true,
    // No saveScriptBoundary: an ordinary open/close --save-script recording,
    // never armed via `replay --save-script` — this is NOT a repair.
    saveScriptPath: outPath,
    actions: [action({ command: 'click', positionals: ['id="new"'] })],
  });

  // Unlike a repair-armed write (which returns `{written:false, error}`), an
  // ordinary (non-repair-armed) write's catch block RETHROWS an AppError
  // (`write()`: `if (repairArmed) return {...}; if (error instanceof
  // AppError) throw error;`) — so refusal here surfaces as a thrown error,
  // not a returned result.
  expect(() => writer.write(session)).toThrow(/already exists/);
  // The pre-existing target is left byte-for-byte unchanged — refused, not
  // clobbered.
  expect(fs.readFileSync(outPath, 'utf8')).toBe(before);
});

// (f) confirm the absent-target case still succeeds for ordinary recording —
// the refusal is scoped to an EXISTING target, not a blanket block.
test('an ordinary (non-repair) recording still publishes cleanly when its target does not exist yet', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-script-writer-ordinary-absent-'),
  );
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const outPath = path.join(root, 'flows', 'fresh.ad');

  const session = makeIosSession('default', {
    recordSession: true,
    // No saveScriptBoundary: ordinary recording, not a repair.
    saveScriptPath: outPath,
    actions: [action({ command: 'click', positionals: ['id="new"'] })],
  });

  const result = writer.write(session);
  expect(result.written).toBe(true);
  expect(result.written && result.path).toBe(outPath);
  const parsed = parseReplayScriptDetailed(fs.readFileSync(outPath, 'utf8'));
  expect(parsed.actions.map((a) => a.positionals[0])).toEqual(['id="new"']);
  // Ordinary recording never carries the repair-only completeness sentinel.
  expect(fs.readFileSync(outPath, 'utf8')).not.toContain(HEAL_COMPLETE_SENTINEL);
});

test('close --save-script=<explicit path> clears the defaulted marker, and a write to that (absent) explicit path succeeds', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-script-writer-close-explicit-'));
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const defaultedHealed = path.join(root, 'flows', 'login.healed.ad');
  const explicitOut = path.join(root, 'flows', 'promoted.ad');

  // The repair defaulted to `.healed.ad` (marker set).
  const session = makeIosSession('default', {
    recordSession: true,
    saveScriptBoundary: 0,
    saveScriptPath: defaultedHealed,
    saveScriptDefaultedHealedPath: true,
    actions: [action({ command: 'click', positionals: ['id="new"'] })],
  });

  // `close --save-script=<explicit path>` re-points the path AND clears the
  // marker (regression: it used to retain the marker and wrongly refuse the
  // explicit target). The marker no longer affects the publish decision at
  // all (refusal is now uniform), but a redirected session must still
  // publish cleanly to its own (absent) explicit target.
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
  // itself — the temp hard-link was cleaned up after the exclusive `linkSync`
  // published the target, not left behind.
  expect(fs.readdirSync(path.dirname(outPath))).toEqual([path.basename(outPath)]);
  expect(fs.readFileSync(outPath, 'utf8')).toContain(HEAL_COMPLETE_SENTINEL);
});
