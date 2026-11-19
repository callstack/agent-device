import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import * as fileSurface from '@agent-device/host-kit/file';
import { withDaemonDiagnosticsScope } from './daemon-diagnostics-scope.ts';
import { mkdtempForTestSync, withCapturedStderrAsync } from '@agent-device/test-kit';

// The state surface the sink asks, wrapped so ONE test can make the surface itself fail. Every other call
// goes to the real rule: a sink is only ever judged by the owner that owns it.
vi.mock('@agent-device/host-kit/file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/file')>();
  return { ...actual, tryOpenPrivateStateFileSync: vi.fn(actual.tryOpenPrivateStateFileSync) };
});

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempForTestSync('agent-device-daemon-diagnostics-scope-');
  logPath = path.join(dir, 'daemon.log');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function readLoggedEvents(): Array<Record<string, unknown>> {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('defaults to a debug daemon scope on the daemon session and returns the body result', async () => {
  const result = await withDaemonDiagnosticsScope({ logPath }, () => {
    emitDiagnostic({ level: 'warn', phase: 'probe', data: { n: 1 } });
    return 'done';
  });

  assert.equal(result, 'done');
  const events = readLoggedEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.command, 'daemon');
  assert.equal(events[0]?.session, 'daemon');
  assert.equal(events[0]?.phase, 'probe');
});

test('forces the buffered events of a non-debug scope out once the body returns', async () => {
  await withDaemonDiagnosticsScope({ logPath, command: 'daemon-startup', debug: false }, () => {
    emitDiagnostic({ level: 'warn', phase: 'first' });
    emitDiagnostic({ level: 'warn', phase: 'second' });
    assert.deepEqual(readLoggedEvents(), []);
  });

  const events = readLoggedEvents();
  assert.deepEqual(
    events.map((event) => event.phase),
    ['first', 'second'],
  );
  assert.ok(events.every((event) => event.command === 'daemon-startup'));
});

test('keeps the record of a failed body and still rethrows', async () => {
  await assert.rejects(
    withDaemonDiagnosticsScope({ logPath, debug: false }, async () => {
      emitDiagnostic({ level: 'warn', phase: 'kept' });
      throw new Error('boom');
    }),
    /boom/,
  );

  assert.deepEqual(
    readLoggedEvents().map((event) => event.phase),
    ['kept'],
  );
});

test.skipIf(process.platform === 'win32')(
  'a scope that logs nothing opens the log for nothing',
  async () => {
    // The judgment used to be an append open asked at every scope entry, so a state directory with no
    // daemon.log gained a 0600 one, and an existing log had its mode said, because some code merely
    // opened a scope. A sink is owed to a LINE, so no line means no open, no create, no mode change.
    const existing = path.join(dir, 'sibling.log');
    fs.writeFileSync(existing, 'bytes\n', { mode: 0o644 });
    fs.chmodSync(existing, 0o644);

    await withDaemonDiagnosticsScope({ logPath }, () => 'quiet');

    assert.equal(fs.existsSync(logPath), false, 'a quiet scope must not create the log');
    assert.equal(fs.statSync(existing).mode & 0o777, 0o644);

    const before = fs.statSync(existing);
    await withDaemonDiagnosticsScope({ logPath: existing }, () => 'quiet again');
    const after = fs.statSync(existing);
    assert.equal(after.mode & 0o777, 0o644, 'a quiet scope must not re-mode an existing log');
    assert.equal(after.ino, before.ino);
  },
);

test.skipIf(process.platform === 'win32')(
  'a line that is written travels through the judged handle and narrows the log',
  async () => {
    // The other half of the same rule: when a line DOES exist, the open happens, the event goes through
    // that descriptor, and the state mode is said on it — an event is never written at the name.
    fs.writeFileSync(logPath, '', { mode: 0o644 });
    fs.chmodSync(logPath, 0o644);

    await withDaemonDiagnosticsScope({ logPath }, () => {
      emitDiagnostic({ level: 'warn', phase: 'logged' });
    });

    const events = readLoggedEvents();
    assert.deepEqual(
      events.map((event) => event.phase),
      ['logged'],
    );
    assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);
  },
);

test.skipIf(process.platform === 'win32')(
  'a log route that breaks costs one line to stderr and is re-judged for the next',
  async () => {
    // The warning sink is an optional diagnostic in both directions: a descriptor that stops taking
    // bytes must not lose the event, and must not end the scope's logging either. The failed line goes
    // to stderr, the sink is dropped, and the next line asks the state rule again.
    fs.writeFileSync(logPath, '', { mode: 0o600 });
    // The sink writes through a DESCRIPTOR, so a descriptor write is the seam that breaks. One throw,
    // then the route works again: the question this row answers is whether the scope keeps logging.
    const realAppend = fs.appendFileSync.bind(fs) as (
      target: unknown,
      ...rest: unknown[]
    ) => unknown;
    let brokeOnce = false;
    const spy = vi.spyOn(fs, 'appendFileSync').mockImplementation(((
      target: unknown,
      ...rest: unknown[]
    ) => {
      if (!brokeOnce && typeof target === 'number') {
        brokeOnce = true;
        throw Object.assign(new Error('EDQUOT'), { code: 'EDQUOT' });
      }
      return realAppend(target, ...rest);
    }) as unknown as typeof fs.appendFileSync);

    let said = '';
    try {
      said = await withCapturedStderrAsync(async () => {
        await withDaemonDiagnosticsScope({ logPath }, () => {
          emitDiagnostic({ level: 'warn', phase: 'first' });
          emitDiagnostic({ level: 'warn', phase: 'second' });
        });
      });
    } finally {
      spy.mockRestore();
    }

    assert.match(said, /daemon_log_sink_failed/);
    assert.match(said, /"phase":"first"/, 'the failed line itself must reach stderr');
    assert.deepEqual(
      readLoggedEvents().map((event) => event.phase),
      ['second'],
      'the sink is re-judged, so later events keep landing in the log',
    );
  },
);

test.skipIf(process.platform === 'win32')(
  'a log whose state mode cannot be proven is not opened as a sink',
  async () => {
    // The rule narrows the mode of an entry it proved to be this process's own and refuses one it could not,
    // AT THE OPEN. A sink kept across that failure would append this run's events to a file every local user
    // can read while the run believed its log were private, so the mode is said and read back on the
    // descriptor before any handle is handed out, and a mode that cannot be said is the open's own refusal —
    // the sink asks the same question nowhere else.
    fs.writeFileSync(logPath, 'earlier\n', { mode: 0o644 });
    fs.chmodSync(logPath, 0o644);
    const fchmod = vi.spyOn(fs, 'fchmodSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });

    let result: string | undefined;
    let said = '';
    try {
      said = await withCapturedStderrAsync(async () => {
        result = await withDaemonDiagnosticsScope({ logPath }, () => {
          emitDiagnostic({ level: 'warn', phase: 'unlogged' });
          return 'done';
        });
      });
    } finally {
      fchmod.mockRestore();
    }

    assert.equal(
      result,
      'done',
      'a log that cannot be made private still costs the daemon nothing',
    );
    // The refusal travels with the reason INSIDE it: one say, at the judgment, naming the mode's cause.
    assert.match(said, /daemon_log_sink_refused/);
    assert.match(said, /EPERM/);
    assert.match(said, /unlogged/, 'the event leaves by the one route that needs no private file');
    assert.equal(fs.readFileSync(logPath, 'utf8'), 'earlier\n', 'no event reaches the loose file');
    assert.equal(fs.statSync(logPath).mode & 0o777, 0o644);
  },
);

test.skipIf(process.platform === 'win32')(
  'a sink setup that fails with a host I/O error is answered as stderr and costs the body nothing',
  async () => {
    // An `EIO` from the device is not one of the exposures the state rule models, and it is not one the sink
    // factory may raise for either: the caller here is a daemon doing work, and a report is not owed it an
    // exception. The open's failure is answered as a refusal, the events leave by stderr, and the body runs.
    const open = vi.spyOn(fs, 'openSync').mockImplementation((() => {
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    }) as unknown as typeof fs.openSync);

    let result: string | undefined;
    let said = '';
    try {
      said = await withCapturedStderrAsync(async () => {
        result = await withDaemonDiagnosticsScope({ logPath }, () => {
          emitDiagnostic({ level: 'warn', phase: 'kept' });
          return 'done';
        });
      });
    } finally {
      open.mockRestore();
    }

    assert.equal(result, 'done');
    assert.match(said, /daemon_log_sink_refused/);
    assert.match(said, /EIO/);
    assert.match(said, /"phase":"kept"/, 'the event still leaves by a route that opens nothing');
    assert.equal(fs.existsSync(logPath), false);
  },
);

test.skipIf(process.platform === 'win32')(
  'a sink owner that cannot answer at all is answered as stderr and costs the body nothing',
  async () => {
    // The open answers its own refusals and the mode answers its own. What is left is a host that fails a
    // seam for a reason the state surface does not model at all, and a sink factory is still not owed an
    // exception: the whole ask is wrapped, so the events leave by stderr and the body runs.
    const ask = vi.mocked(fileSurface.tryOpenPrivateStateFileSync);
    ask.mockImplementationOnce((): never => {
      throw new Error('the state surface could not answer');
    });

    let result: string | undefined;
    let said = '';
    try {
      said = await withCapturedStderrAsync(async () => {
        result = await withDaemonDiagnosticsScope({ logPath }, () => {
          emitDiagnostic({ level: 'warn', phase: 'kept' });
          return 'done';
        });
      });
    } finally {
      ask.mockReset();
    }

    assert.equal(result, 'done');
    assert.match(said, /daemon_log_sink_unavailable/);
    assert.match(said, /"phase":"kept"/);
    assert.equal(fs.existsSync(logPath), false);
  },
);

test.skipIf(process.platform === 'win32')(
  'runs the body with no log sink when the state rule refuses that log',
  async () => {
    // The log is a state record, so it is a sink only while the state rule accepts it. Writing diagnostics at a
    // refused name would put them through the link (or block on the FIFO) that made the refusal, which is the
    // very thing being reported. So the scope runs, and the events leave by stderr.
    const victim = path.join(dir, 'theirs.log');
    fs.writeFileSync(victim, 'not yours\n', { mode: 0o600 });
    fs.symlinkSync(victim, logPath, 'file');

    const said = await withCapturedStderrAsync(async () => {
      await withDaemonDiagnosticsScope({ logPath }, () => {
        emitDiagnostic({ level: 'warn', phase: 'unlogged' });
      });
    });

    // The link's target keeps its bytes, the refusal is said, and the event itself leaves by stderr — the one
    // route no entry in the refused directory can steer.
    assert.equal(fs.readFileSync(victim, 'utf8'), 'not yours\n');
    assert.match(said, /daemon_log_sink_refused/);
    assert.match(said, /unlogged/);
  },
);
