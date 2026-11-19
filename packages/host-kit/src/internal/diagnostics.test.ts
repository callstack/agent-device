import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  type DiagnosticLineSink,
  emitDiagnostic,
  flushDiagnosticsToSessionFile,
  registerDiagnosticSensitiveValue,
  updateDiagnosticsScope,
  withDiagnosticsScope,
  withDiagnosticTimer,
} from './diagnostics.ts';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';

test('a log path with no line never asks for a sink, and every line after one goes through it', async () => {
  // The question "may this path be written" is answered by the sink's owner, and asking it costs an open.
  // A scope that emits nothing must therefore cost nothing at the path, and once a line exists, that
  // line and the forced flush both travel through the sink the answer produced — never through the name.
  const directory = mkdtempForTestSync('agent-device-diag-sink-');
  const logPath = path.join(directory, 'daemon.log');
  const sinkFile = path.join(directory, 'through-the-sink.ndjson');
  const asked: string[] = [];
  let closed = 0;
  const factory = (pathname: string): DiagnosticLineSink => {
    asked.push(pathname);
    return {
      write: (line) => {
        fs.appendFileSync(sinkFile, line, 'utf8');
        return true;
      },
      close: () => {
        closed += 1;
      },
    };
  };

  await withDiagnosticsScope({ debug: true, logPath, logSinkFactory: factory }, () => 'quiet');
  assert.deepEqual(asked, [], 'a scope that logged nothing must not have asked for a sink');
  assert.equal(fs.existsSync(logPath), false, 'a quiet scope creates no log');
  assert.equal(fs.existsSync(sinkFile), false);

  await withDiagnosticsScope({ debug: true, logPath, logSinkFactory: factory }, async () => {
    emitDiagnostic({ phase: 'one' });
    emitDiagnostic({ phase: 'two' });
    flushDiagnosticsToSessionFile({ force: true });
  });
  assert.deepEqual(asked, [logPath], 'one judgment serves the whole scope, the flush included');
  assert.deepEqual(
    fs
      .readFileSync(sinkFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { phase: string }).phase),
    ['one', 'two'],
  );
  assert.equal(closed, 1, 'the sink is let go of when the scope ends');
  assert.equal(fs.existsSync(logPath), false, 'no byte was ever written at the name');
});

test('a log path that moves on takes its own judge with it', async () => {
  // A daemon scope can hand off to a session request record. That new path is a different owner's ground:
  // the handle judged for the old one, and the judge itself, must not follow the scope across.
  const directory = mkdtempForTestSync('agent-device-diag-sink-move-');
  const first = path.join(directory, 'daemon.log');
  const second = path.join(directory, 'request.ndjson');
  const sinkFile = path.join(directory, 'through-the-sink.ndjson');
  let closed = 0;
  const asked: string[] = [];

  await withDiagnosticsScope(
    {
      debug: true,
      logPath: first,
      logSinkFactory: (pathname) => {
        asked.push(pathname);
        return {
          write: (line) => {
            fs.appendFileSync(sinkFile, line, 'utf8');
            return true;
          },
          close: () => {
            closed += 1;
          },
        };
      },
    },
    () => {
      emitDiagnostic({ phase: 'as-daemon-log' });
      updateDiagnosticsScope({ logPath: second });
      emitDiagnostic({ phase: 'as-request-log' });
    },
  );

  assert.deepEqual(asked, [first], 'only the path the factory was named for is judged');
  assert.equal(closed, 1, "the old path's handle is released at the move");
  assert.match(fs.readFileSync(sinkFile, 'utf8'), /as-daemon-log/);
  const moved = fs.readFileSync(second, 'utf8');
  assert.match(moved, /as-request-log/, 'the new path is written plainly, as it always was');
  assert.equal(
    moved.includes('as-daemon-log'),
    false,
    'no line is replayed through a stale handle',
  );
});

test('diagnostics redacts sensitive fields', async () => {
  const previousHome = process.env.HOME;
  const tempHome = mkdtempForTestSync('agent-device-diag-redact-');
  process.env.HOME = tempHome;
  try {
    const outputPath = await withDiagnosticsScope(
      {
        session: 'redaction-session',
        requestId: 'r2',
        command: 'fill',
      },
      async () => {
        emitDiagnostic({
          phase: 'request_failed',
          level: 'error',
          data: {
            token: 'secret-token',
            text: 'sensitive text',
            responseText:
              'access_token=oauth-access refresh_token:oauth-refresh password=https://secret.example/token',
            setupHint: 'Create a service/API token: https://bridge.agent-device.dev/api-keys',
            nested: { authorization: 'Bearer abc' },
            agentToken: 'adc_agent_secret',
            deviceUrl: 'https://cloud.agent-device.dev/device?user_code=ABCD-EFGH',
            userCode: 'ABCD-EFGH',
            safe: 'ok',
          },
        });
        return flushDiagnosticsToSessionFile({ force: true })?.path;
      },
    );

    assert.ok(outputPath);
    const rows = fs
      .readFileSync(outputPath as string, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const payload = rows[0]?.data ?? {};
    assert.equal(payload.token, '[REDACTED]');
    assert.equal(payload.text, 'sensitive text');
    assert.equal(
      payload.responseText,
      'access_token=[REDACTED] refresh_token:[REDACTED] password=[REDACTED]',
    );
    assert.equal(
      payload.setupHint,
      'Create a service/API token: https://bridge.agent-device.dev/api-keys',
    );
    assert.equal(payload.nested?.authorization, '[REDACTED]');
    assert.equal(payload.agentToken, '[REDACTED]');
    assert.equal(payload.deviceUrl, 'https://cloud.agent-device.dev/device?REDACTED');
    assert.equal(payload.userCode, '[REDACTED]');
    assert.equal(payload.safe, 'ok');
  } finally {
    process.env.HOME = previousHome;
  }
});

test('diagnostics scrubs caller-declared recorded input literals regardless of field name', async () => {
  const outputPath = path.join(
    mkdtempForTestSync('agent-device-diag-recorded-input-'),
    'request.ndjson',
  );
  const secret = 'opaque-value-without-sensitive-keywords';

  await withDiagnosticsScope({ command: 'fill', logPath: outputPath }, async () => {
    registerDiagnosticSensitiveValue(secret);
    emitDiagnostic({
      phase: 'platform_failure',
      data: { text: secret, message: `Backend echoed ${secret}` },
    });
    flushDiagnosticsToSessionFile({ force: true });
  });

  const diagnostics = fs.readFileSync(outputPath, 'utf8');
  assert.equal(diagnostics.includes(secret), false);
  assert.match(diagnostics, /Backend echoed \[REDACTED\]/);
});

test('overlapping sensitive values replace longest-first even when registered out of order', async () => {
  const outputPath = path.join(mkdtempForTestSync('agent-device-diag-overlap-'), 'request.ndjson');
  const shortLiteral = 'secret-value';
  const longLiteral = `${shortLiteral}-extended`;

  await withDiagnosticsScope({ command: 'fill', logPath: outputPath }, async () => {
    registerDiagnosticSensitiveValue(shortLiteral);
    registerDiagnosticSensitiveValue(longLiteral);
    emitDiagnostic({
      phase: 'platform_failure',
      data: { message: `echoed ${longLiteral} tail` },
    });
    flushDiagnosticsToSessionFile({ force: true });
  });

  const diagnostics = fs.readFileSync(outputPath, 'utf8');
  assert.equal(diagnostics.includes(longLiteral), false);
  assert.equal(diagnostics.includes(shortLiteral), false);
  // Shortest-first replacement would leave '[REDACTED]-extended' behind.
  assert.match(diagnostics, /echoed \[REDACTED\] tail/);
});

test('a value registered after an emit but before flush is replaced in the flushed file', async () => {
  const outputPath = path.join(
    mkdtempForTestSync('agent-device-diag-late-register-'),
    'request.ndjson',
  );
  const lateSecret = 'late-registered-opaque-literal';

  await withDiagnosticsScope({ command: 'fill', logPath: outputPath }, async () => {
    emitDiagnostic({
      phase: 'platform_failure',
      data: { message: `captured ${lateSecret}` },
    });
    registerDiagnosticSensitiveValue(lateSecret);
    flushDiagnosticsToSessionFile({ force: true });
  });

  const diagnostics = fs.readFileSync(outputPath, 'utf8');
  assert.equal(diagnostics.includes(lateSecret), false);
  assert.match(diagnostics, /captured \[REDACTED\]/);
});

test('a line the sink setup itself emits never travels through the sink being built', () => {
  // Sink setup is an act of judgment on that very path: opening it, proving its mode. A warning IT emits —
  // "the mode could not be said on this handle" is one — must not be appended at the name, whose judgment is
  // what is still being made, and must not ask for a second sink. It goes to stderr, which no entry in that
  // directory can steer.
  const directory = mkdtempForTestSync('agent-device-diag-setup-warning-');
  const logPath = path.join(directory, 'daemon.log');
  const sinkFile = path.join(directory, 'through-the-sink.ndjson');
  const asked: string[] = [];

  const said = captureStderrWrites(() => {
    withDiagnosticsScope(
      {
        debug: true,
        logPath,
        logSinkFactory: (pathname) => {
          asked.push(pathname);
          // The setup itself reports something while it is still deciding about this path.
          emitDiagnostic({ level: 'warn', phase: 'during_setup' });
          return {
            write: (line) => {
              fs.appendFileSync(sinkFile, line, 'utf8');
              return true;
            },
            close: () => {},
          };
        },
      },
      () => emitDiagnostic({ phase: 'after_setup' }),
    );
  });

  assert.match(said, /"phase":"during_setup"/, 'the setup warning is said on stderr');
  assert.deepEqual(asked, [logPath], 'one judgment serves the setup warning and the line after it');
  const throughSink = fs.readFileSync(sinkFile, 'utf8');
  assert.equal(
    throughSink.includes('during_setup'),
    false,
    'a warning raised by setup is kept out of the handle whose authority setup is deciding',
  );
  assert.match(throughSink, /after_setup/);
  assert.equal(fs.existsSync(logPath), false, 'nothing is written at the name');
});

test('a sink whose owner cannot answer costs the line to stderr and is asked again next time', () => {
  // The setup of a sink touches the host, so it fails for reasons no rule models. That is a refused route,
  // not an exception the caller of `emitDiagnostic` is owed: the event leaves by stderr, nothing is written at
  // the name, and the next line gets a fresh judgment rather than a permanently dead log.
  const directory = mkdtempForTestSync('agent-device-diag-sink-throw-');
  const logPath = path.join(directory, 'daemon.log');
  const sinkFile = path.join(directory, 'through-the-sink.ndjson');
  const asked: string[] = [];

  const said = captureStderrWrites(() => {
    withDiagnosticsScope(
      {
        debug: true,
        logPath,
        logSinkFactory: (pathname) => {
          asked.push(pathname);
          if (asked.length === 1) throw Object.assign(new Error('EIO'), { code: 'EIO' });
          return {
            write: (line) => {
              fs.appendFileSync(sinkFile, line, 'utf8');
              return true;
            },
            close: () => {},
          };
        },
      },
      () => {
        emitDiagnostic({ level: 'warn', phase: 'first' });
        emitDiagnostic({ phase: 'second' });
      },
    );
  });

  assert.match(said, /"phase":"first"/, 'the line that had nowhere to go is said on stderr');
  assert.deepEqual(asked, [logPath, logPath], 'the next line asks the owner again');
  assert.match(fs.readFileSync(sinkFile, 'utf8'), /second/);
  assert.equal(fs.existsSync(logPath), false);
});

test('a plain log path whose write fails costs a warning and never the caller', () => {
  // The unjudged append is an optional diagnostic: an `EIO` from the device, or a directory that cannot be
  // made, must not raise out of `emitDiagnostic` and must not end the scope's logging. Both the warning and
  // its own stderr fallback are I/O acts too, so the whole path is contained.
  const directory = mkdtempForTestSync('agent-device-diag-write-fails-');
  const logPath = path.join(directory, 'request.ndjson');
  const realAppend = fs.appendFileSync.bind(fs);
  let brokeOnce = false;
  const append = vi.spyOn(fs, 'appendFileSync').mockImplementation(((
    target: unknown,
    ...rest: unknown[]
  ) => {
    if (!brokeOnce && target === logPath) {
      brokeOnce = true;
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    }
    return (realAppend as (...args: unknown[]) => unknown)(target, ...rest);
  }) as typeof fs.appendFileSync);

  let said = '';
  try {
    said = captureStderrWrites(() => {
      withDiagnosticsScope({ command: 'fill', logPath, debug: true }, () => {
        assert.doesNotThrow(() => emitDiagnostic({ phase: 'lost' }));
        emitDiagnostic({ phase: 'kept' });
      });
    });
  } finally {
    append.mockRestore();
  }

  assert.match(said, /diagnostic_log_write_failed/);
  assert.match(said, /"phase":"lost"/, 'the line that could not land is said on stderr');
  assert.match(fs.readFileSync(logPath, 'utf8'), /kept/, 'later lines keep reaching the log');
});

test('a log path whose directory cannot be made costs a warning and never the caller', () => {
  // The `mkdir` on the plain path is the other I/O act on that route: a read-only mount answers EROFS and
  // the scope still runs.
  const directory = mkdtempForTestSync('agent-device-diag-mkdir-fails-');
  const logPath = path.join(directory, 'nested', 'request.ndjson');
  const mkdir = vi.spyOn(fs, 'mkdirSync').mockImplementation((() => {
    throw Object.assign(new Error('EROFS'), { code: 'EROFS' });
  }) as unknown as typeof fs.mkdirSync);

  let said = '';
  try {
    said = captureStderrWrites(() => {
      withDiagnosticsScope({ command: 'fill', logPath, debug: true }, () => {
        assert.doesNotThrow(() => emitDiagnostic({ phase: 'nowhere' }));
      });
    });
  } finally {
    mkdir.mockRestore();
  }

  assert.match(said, /diagnostic_log_write_failed/);
  assert.match(said, /"phase":"nowhere"/);
});

test('a directory that could not be made is asked for again, not remembered as made', () => {
  // `ensuredDirectories` is the memo that keeps a per-line `mkdir` off a route that is already open. A parent
  // whose `mkdir` THREW was not made, and remembering it anyway would spend every later line of the scope on
  // a directory that does not exist: the line after a transient fault then lands nowhere, and the scope's log
  // silently stops at the fault instead of recovering once the host answers again.
  const directory = mkdtempForTestSync('agent-device-diag-mkdir-retry-');
  const logPath = path.join(directory, 'nested', 'request.ndjson');
  const realMkdir = fs.mkdirSync.bind(fs);
  let mkdirFailsOnce = true;
  const mkdir = vi.spyOn(fs, 'mkdirSync').mockImplementation(((
    target: unknown,
    ...rest: unknown[]
  ) => {
    if (mkdirFailsOnce && target === path.dirname(logPath)) {
      mkdirFailsOnce = false;
      throw Object.assign(new Error('EROFS'), { code: 'EROFS' });
    }
    return (realMkdir as (...args: unknown[]) => unknown)(target, ...rest);
  }) as typeof fs.mkdirSync);

  try {
    captureStderrWrites(() => {
      withDiagnosticsScope({ command: 'fill', logPath, debug: true }, () => {
        emitDiagnostic({ phase: 'first_after_fault' });
        emitDiagnostic({ phase: 'second_after_fault' });
      });
    });

    assert.equal(
      mkdirSpyCallsFor(mkdir, path.dirname(logPath)),
      2,
      'the parent is asked for again',
    );
    const lines = fs.readFileSync(logPath, 'utf8');
    assert.match(
      lines,
      /"phase":"second_after_fault"/,
      'the line after a failed mkdir still reaches the log',
    );
  } finally {
    mkdir.mockRestore();
  }
});

/** Counts the calls a `mkdirSync` spy saw for exactly one directory. */
function mkdirSpyCallsFor(spy: { mock: { calls: unknown[][] } }, dir: string): number {
  return spy.mock.calls.filter(([target]) => target === dir).length;
}

test('a flush whose append did not land names no record, and keeps the events owed', () => {
  // `flushDiagnosticsToSessionFile` answers WHERE the record is, and request finalization copies that answer
  // into the error's `logPath` and `diagnosticsRecord`. On ENOSPC, EROFS, or a sessions directory that has
  // gone away, a returned path is a pointer to a file holding none of the scope's events, which is worse than
  // no pointer: the caller opens it, finds nothing, and distrusts the diagnostics. So a line that did not land
  // makes the flush answer null, and the events stay owed to a later flush that can deliver them.
  const directory = mkdtempForTestSync('agent-device-diag-flush-fails-');
  const logPath = path.join(directory, 'request.ndjson');
  const realAppend = fs.appendFileSync.bind(fs);
  let appendIsBroken = true;
  const append = vi.spyOn(fs, 'appendFileSync').mockImplementation(((
    target: unknown,
    ...rest: unknown[]
  ) => {
    if (appendIsBroken && target === logPath) {
      throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    }
    return (realAppend as (...args: unknown[]) => unknown)(target, ...rest);
  }) as typeof fs.appendFileSync);

  let flushedOnce: unknown;
  let standingAfterRefusal: boolean | undefined;
  let flushedAfterRepair: unknown;
  try {
    withDiagnosticsScope({ command: 'fill', logPath, debug: true }, () => {
      captureStderrWrites(() => emitDiagnostic({ phase: 'unwritten' }));
      flushedOnce = flushDiagnosticsToSessionFile({ force: true });
      standingAfterRefusal = fs.existsSync(logPath);
      appendIsBroken = false;
      flushedAfterRepair = flushDiagnosticsToSessionFile({ force: true });
    });
  } finally {
    append.mockRestore();
  }

  assert.equal(flushedOnce, null, 'a record that never landed is not a record');
  assert.equal(standingAfterRefusal, false, 'the refused append created nothing at the name');
  assert.deepEqual(
    flushedAfterRepair,
    { path: logPath },
    'the same events land once the route works',
  );
  const written = fs.readFileSync(logPath, 'utf8');
  assert.match(written, /"phase":"unwritten"/, 'the flush did not silently drop the owed events');
  const unwrittenLines = written.split('\n').filter((line) => line.includes('"phase":"unwritten"'));
  assert.equal(unwrittenLines.length, 1, 'the owed event lands exactly once, not again per flush');
});

/** Runs `run` with every write to this process's stderr collected, and returns what was said. */
function captureStderrWrites(run: () => void): string {
  let said = '';
  const write = process.stderr.write.bind(process.stderr);
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    said += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  });
  try {
    run();
  } finally {
    spy.mockRestore();
    process.stderr.write = write;
  }
  return said;
}

test('appendDiagnosticLine ensures the log directory once across appended lines', () => {
  const logDir = mkdtempForTestSync('agent-device-diag-mkdir-');
  const logPath = path.join(logDir, 'nested', 'request.ndjson');
  const mkdirSpy = vi.spyOn(fs, 'mkdirSync');
  try {
    withDiagnosticsScope({ command: 'fill', logPath, debug: true }, () => {
      for (let index = 0; index < 3; index += 1) {
        emitDiagnostic({ phase: `iteration_${index}`, data: { index } });
      }
    });

    const callsForLogDir = mkdirSpy.mock.calls.filter(([dir]) => dir === path.dirname(logPath));
    assert.equal(callsForLogDir.length, 1);
    assert.equal(fs.readFileSync(logPath, 'utf8').trim().split('\n').length, 3);
  } finally {
    mkdirSpy.mockRestore();
  }
});

test('a later diagnostics scope recreates a removed log directory', async () => {
  const rootDir = mkdtempForTestSync('agent-device-diag-recreate-');
  const logDir = path.join(rootDir, 'nested');
  const logPath = path.join(logDir, 'request.ndjson');
  const mkdirSpy = vi.spyOn(fs, 'mkdirSync');
  try {
    await withDiagnosticsScope({ command: 'first', logPath, debug: true }, () => {
      emitDiagnostic({ phase: 'first_scope' });
    });
    fs.rmSync(logDir, { recursive: true, force: true });

    await withDiagnosticsScope({ command: 'second', logPath, debug: true }, () => {
      emitDiagnostic({ phase: 'second_scope' });
    });

    const callsForLogDir = mkdirSpy.mock.calls.filter(([dir]) => dir === logDir);
    assert.equal(callsForLogDir.length, 2);
    assert.match(fs.readFileSync(logPath, 'utf8'), /second_scope/);
  } finally {
    mkdirSpy.mockRestore();
  }
});

for (const startEvent of [undefined, 'start']) {
  for (const failureKind of ['none', 'throw', 'reject']) {
    const fails = failureKind !== 'none';
    test(`diagnostic timer preserves result/error and event contract (start=${startEvent}, failure=${failureKind})`, async () => {
      const logPath = path.join(mkdtempForTestSync('diagnostic-timer-'), 'request.ndjson');
      const failure = new Error('fixture phase failure');
      const result = { prepared: true };
      await withDiagnosticsScope({ logPath, flushOnSuccess: true }, async () => {
        const timed = withDiagnosticTimer(
          'fixture_phase',
          () => {
            if (failureKind === 'throw') throw failure;
            if (failureKind === 'reject') return Promise.reject(failure);
            return Promise.resolve(result);
          },
          { timeoutMs: 100 },
          startEvent,
        );
        if (fails) await assert.rejects(timed, (error: unknown) => error === failure);
        else assert.equal(await timed, result);
        flushDiagnosticsToSessionFile();
      });
      const rows = fs
        .readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        rows.map((row) => [row.phase, row.level, row.data.event]),
        [
          ...(startEvent ? [['fixture_phase', 'info', 'start']] : []),
          ['fixture_phase', fails ? 'error' : 'info', startEvent ? 'settled' : undefined],
        ],
      );
      assert.equal(rows.at(-1).data.timeoutMs, 100);
      assert.ok(rows.at(-1).durationMs >= 0);
      assert.equal(rows.at(-1).data.error, fails && !startEvent ? failure.message : undefined);
    });
  }
}

test.each([false, true])('diagnostics preserve bigint precision with debug=%s', async (debug) => {
  const logPath = path.join(mkdtempForTestSync('agent-device-diag-bigint-'), 'events.ndjson');
  await withDiagnosticsScope({ debug, logPath }, async () => {
    emitDiagnostic({
      phase: 'owner_shutdown_failed',
      data: {
        observedAtNs: 9_007_199_254_740_993n,
        samples: [1n, 42n],
        authorization: 'Bearer secret',
      },
    });
    assert.equal(flushDiagnosticsToSessionFile({ force: true })?.path, logPath);
  });
  const rows = fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].data, {
    observedAtNs: '9007199254740993',
    samples: ['1', '42'],
    authorization: '[REDACTED]',
  });
});

test.each(['toJSON', 'getter'] as const)(
  'diagnostic %s failure cannot escape emission',
  async (fault) => {
    const evidence =
      fault === 'toJSON'
        ? {
            toJSON: () => {
              throw new Error('serialization hook failed');
            },
          }
        : Object.defineProperty({}, 'value', {
            enumerable: true,
            get() {
              throw new Error('diagnostic getter failed');
            },
          });
    const logPath = path.join(mkdtempForTestSync('agent-device-diag-invalid-'), 'events.ndjson');
    await withDiagnosticsScope({ debug: true, logPath }, async () => {
      assert.doesNotThrow(() =>
        emitDiagnostic({ phase: 'owner_shutdown_failed', data: { evidence } }),
      );
      assert.equal(flushDiagnosticsToSessionFile({ force: true })?.path, logPath);
    });
    const rows = fs
      .readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      rows.map(({ phase, data }) => ({ phase, data })),
      [{ phase: 'owner_shutdown_failed', data: { reason: 'diagnostic-data-unserializable' } }],
    );
  },
);

test.each([false, true])(
  'invalid data preserves following diagnostic events with debug=%s',
  async (debug) => {
    const logPath = path.join(mkdtempForTestSync('agent-device-diag-following-'), 'events.ndjson');
    await withDiagnosticsScope({ debug, logPath }, async () => {
      emitDiagnostic({
        phase: 'bad_metadata',
        data: {
          toJSON: () => {
            throw new Error('serialization hook failed');
          },
        },
      });
      emitDiagnostic({ phase: 'request_failed', data: { reason: 'original-refusal' } });
      assert.equal(flushDiagnosticsToSessionFile({ force: true })?.path, logPath);
    });
    const rows = fs
      .readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      rows.map(({ phase, data }) => ({ phase, data })),
      [
        { phase: 'bad_metadata', data: { reason: 'diagnostic-data-unserializable' } },
        { phase: 'request_failed', data: { reason: 'original-refusal' } },
      ],
    );
  },
);

test.each([
  [false, false],
  [false, true],
  [true, false],
] as const)(
  'bigint sensitive literals are redacted (debug=%s, late registration=%s)',
  async (debug, late) => {
    const secret = '9007199254740993';
    const logPath = path.join(
      mkdtempForTestSync('agent-device-diag-bigint-secret-'),
      'events.ndjson',
    );
    await withDiagnosticsScope({ debug, logPath }, async () => {
      if (!late) registerDiagnosticSensitiveValue(secret);
      emitDiagnostic({
        phase: 'owner_shutdown_failed',
        data: {
          direct: 9_007_199_254_740_993n,
          nested: [4_290_071_992_547_409_937n],
          generated: { toJSON: () => 9_007_199_254_740_993n },
        },
      });
      if (late) registerDiagnosticSensitiveValue(secret);
      assert.equal(flushDiagnosticsToSessionFile({ force: true })?.path, logPath);
    });
    const raw = fs.readFileSync(logPath, 'utf8');
    assert.equal(raw.includes(secret), false);
    const rows = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(rows[0].data, {
      direct: '[REDACTED]',
      nested: ['42[REDACTED]7'],
      generated: '[REDACTED]',
    });
  },
);
