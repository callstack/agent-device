import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionScriptWriter } from '../session-script-writer.ts';
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
    actions: [action({ command: 'press', positionals: ['@e7'] })],
  });

  const scriptPath = path.join(root, 'sessions', 'default', 'expected-not-written.ad');
  expect(() => writer.write(session)).toThrow(/never resolved to a selector/);
  // Fail loud, not a swallowed { written: false } — no file was produced.
  expect(fs.existsSync(scriptPath)).toBe(false);
  expect(fs.readdirSync(path.join(root, 'sessions')).length).toBe(0);
});

test('a bare-@ref fill action also fails loud, not just click-like commands', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-script-writer-bare-ref-fill-'));
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const session = makeIosSession('default', {
    recordSession: true,
    saveScriptBoundary: 0,
    actions: [action({ command: 'fill', positionals: ['@e9', 'hello'] })],
  });

  expect(() => writer.write(session)).toThrow(/never resolved to a selector/);
});

test('a bare @ref later in the same session (after a resolved earlier action) still fails loud, writing nothing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-script-writer-partial-write-'));
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const session = makeIosSession('default', {
    recordSession: true,
    saveScriptBoundary: 0,
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

  expect(() => writer.write(session)).toThrow(/never resolved to a selector/);
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

test('write() refuses to clobber an existing DEFAULT .healed.ad (no explicit --save-script=<path>)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-script-writer-clobber-'));
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const healedPath = path.join(root, 'flows', 'login.healed.ad');
  fs.mkdirSync(path.dirname(healedPath), { recursive: true });
  // A prior, unreviewed healed script already sits at the default sibling path.
  fs.writeFileSync(healedPath, 'context platform=ios device="x"\nclick id="old"\n');
  const before = fs.readFileSync(healedPath, 'utf8');

  const session = makeIosSession('default', {
    recordSession: true,
    saveScriptBoundary: 0,
    saveScriptPath: healedPath,
    saveScriptDefaultedHealedPath: true,
    actions: [action({ command: 'click', positionals: ['id="new"'] })],
  });

  expect(() => writer.write(session)).toThrow(/already exists/);
  // Fail loud — the prior unreviewed diff is untouched.
  expect(fs.readFileSync(healedPath, 'utf8')).toBe(before);
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

  const result = writer.write(session);
  expect(result.written).toBe(true);
  expect(result.written && result.path).toBe(explicitOut);
  const parsed = parseReplayScriptDetailed(fs.readFileSync(explicitOut, 'utf8'));
  expect(parsed.actions.some((a) => a.positionals[0] === 'id="new"')).toBe(true);
});
