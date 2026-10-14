import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test, vi } from 'vitest';
import { installFakeManagedAgentBrowser, mkdtempForTestSync } from './__tests__/test-utils.ts';

const { providerStartupCleanupMock } = vi.hoisted(() => ({
  providerStartupCleanupMock: vi.fn(),
}));

// Startup cleanup walks the host process table, which would read as an extra backend call in the
// exact call lists these tests assert.
vi.mock('./agent-browser-lifecycle.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent-browser-lifecycle.ts')>();
  return {
    ...actual,
    cleanupManagedAgentBrowserOrphansForProviderStartup: providerStartupCleanupMock,
  };
});

import { createAgentBrowserWebProvider } from './agent-browser-provider.ts';
import type { WebSnapshotResult } from './provider.ts';
import { withCommandExecutorOverride, type ExecResult } from '@agent-device/host-kit/command';
import { AppError } from '@agent-device/kernel/errors';

/**
 * One backend call, with the text the provider wrote to its stdin — which is how `batch` receives
 * the work it runs inside a single process.
 */
type AgentBrowserCall = {
  cmd: string;
  args: readonly string[];
  stdin?: string;
};

test('agent-browser provider fetches snapshot geometry in one batch for the whole capture', async () => {
  await withWebProvider(async (provider) => {
    const calls: AgentBrowserCall[] = [];
    const snapshot = await withCommandExecutorOverride(
      geometryExecutor(calls),
      async () => await provider.snapshot({ includeRects: true }),
    );

    assert.deepEqual(
      calls.map((call) => call.args.slice(0, 3)),
      [
        ['snapshot', '--json', '--session'],
        ['batch', '--json', '--session'],
      ],
    );
    // One round trip for every ref of the capture: each backend call is a process spawn, and a page
    // can hold hundreds of refs.
    assert.deepEqual(readBatchCommands(calls[1]?.stdin), [
      ['get', 'box', '@e1'],
      ['get', 'box', '@e2'],
      ['get', 'box', '@e3'],
      ['get', 'box', '@e4'],
    ]);
    assertGeometryRects(snapshot);
  });
});

test('agent-browser provider keeps the geometry a batch did measure', async () => {
  await withWebProvider(async (provider) => {
    const calls: AgentBrowserCall[] = [];
    const snapshot = await withCommandExecutorOverride(
      async (cmd, args, options) => {
        const cliArgs = recordCall(calls, cmd, args, options.stdin);
        if (cliArgs[0] !== 'batch') return snapshotPayload();
        const commands = readBatchCommands(options.stdin);
        return jsonResult(
          commands.map((command, index) =>
            index === 0
              ? { command, success: false, error: 'Unknown ref: e1', result: null }
              : { command, success: true, error: null, result: boxRect(command[2]) },
          ),
          1,
        );
      },
      async () => await provider.snapshot({ includeRects: true }),
    );

    // A ref the backend could not measure is an ordinary answer about that ref: the rest of the
    // tree keeps its geometry, and the entry's own `success` is what decided that — never the
    // error's wording, which the backend has no reason to keep stable.
    assert.deepEqual(
      snapshot.nodes.map((node) => node.rect),
      [
        undefined,
        { x: 11, y: 12, width: 100, height: 20 },
        { x: 31, y: 32, width: 100, height: 20 },
        { x: 31, y: 32, width: 100, height: 20 },
      ],
    );
  });
});

test('agent-browser provider splits snapshot geometry into bounded batches', async () => {
  await withWebProvider(async (provider) => {
    const calls: AgentBrowserCall[] = [];
    const snapshot = await withCommandExecutorOverride(
      async (cmd, args, options) => {
        const cliArgs = recordCall(calls, cmd, args, options.stdin);
        if (cliArgs[0] !== 'batch') return manyRefSnapshotPayload(250);
        const commands = readBatchCommands(options.stdin);
        return jsonResult(
          commands.map((command) => ({
            command,
            success: true,
            error: null,
            result: { x: 1, y: 2, width: 10, height: 20 },
          })),
          1,
        );
      },
      async () => await provider.snapshot({ includeRects: true }),
    );

    // The backend reads a batch from stdin as one JSON array, so refs are fetched in bounded groups
    // rather than as one unbounded payload.
    const groups = calls
      .filter((call) => call.args[0] === 'batch')
      .map((call) => readBatchCommands(call.stdin));
    assert.deepEqual(
      groups.map((group) => group.length),
      [200, 50],
    );
    assert.equal(
      snapshot.nodes.filter((node) => node.rect !== undefined).length,
      250,
      'every ref of both groups keeps the box its entry reported',
    );
  });
});

test('agent-browser provider keeps a capture whose later groups measured after an early one failed', async () => {
  // The refusal below is a statement about the capture, so it has to be decided over all of it: a
  // page whose first group of refs went stale still has geometry for the rest, and answering that
  // capture is what the caller can act on.
  await withWebProvider(async (provider) => {
    const calls: AgentBrowserCall[] = [];
    const snapshot = await withCommandExecutorOverride(
      async (cmd, args, options) => {
        const cliArgs = recordCall(calls, cmd, args, options.stdin);
        if (cliArgs[0] !== 'batch') return manyRefSnapshotPayload(250);
        const commands = readBatchCommands(options.stdin);
        const firstGroup = commands.length === 200;
        return jsonResult(
          commands.map((command) =>
            firstGroup
              ? { command, success: false, error: 'Unknown ref', result: null }
              : {
                  command,
                  success: true,
                  error: null,
                  result: { x: 1, y: 2, width: 10, height: 20 },
                },
          ),
          1,
        );
      },
      async () => await provider.snapshot({ includeRects: true }),
    );

    assert.equal(
      snapshot.nodes.filter((node) => node.rect !== undefined).length,
      50,
      'the group that answered keeps its geometry',
    );
    assert.equal(
      calls.filter((call) => call.args[0] === 'batch').length,
      2,
      'both groups were asked',
    );
  });
});

test('agent-browser provider refuses snapshot geometry when the batch resolves no refs', async () => {
  // An element the backend knows measures as a box even when hidden, so a capture whose every ref
  // went unmeasurable answered to refs this snapshot does not publish. Returning no geometry at all
  // would hand the caller a tree of targets with no usable bounds.
  await withWebProvider(async (provider) => {
    await assert.rejects(
      () =>
        withCommandExecutorOverride(
          async (_cmd, args, options) => {
            if (agentBrowserCliArgs(args)[0] !== 'batch') return snapshotPayload();
            const commands = readBatchCommands(options.stdin);
            return jsonResult(
              commands.map((command) => ({
                command,
                success: false,
                error: 'Unknown ref',
                result: null,
              })),
              1,
            );
          },
          async () => await provider.snapshot({ includeRects: true }),
        ),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'COMMAND_FAILED' &&
        error.details?.reason === 'snapshot-refs-unmeasurable' &&
        error.details?.measuredRects === 0,
    );
  });
});

test('agent-browser provider refuses geometry when the batch answers with too few entries', async () => {
  // Each entry has to name the command it answers, so an answer with fewer entries than commands
  // cannot be paired at all: filling four refs from the entries that exist would hand each node some
  // other node's box.
  await withWebProvider(async (provider) => {
    await assert.rejects(
      () =>
        withCommandExecutorOverride(
          async (_cmd, args, options) => {
            if (agentBrowserCliArgs(args)[0] !== 'batch') return snapshotPayload();
            const commands = readBatchCommands(options.stdin);
            return jsonResult(
              [{ command: commands[0], success: true, error: null, result: boxRect('@e1') }],
              1,
            );
          },
          async () => await provider.snapshot({ includeRects: true }),
        ),
      refusedFor('entry-count'),
    );
  });
});

test('agent-browser provider refuses geometry when the batch answers with an object', async () => {
  // An answer that is not a list of entries cannot be paired to refs at all, so the geometry is
  // refused rather than guessed at.
  await withWebProvider(async (provider) => {
    await assert.rejects(
      () =>
        withCommandExecutorOverride(
          async (_cmd, args) =>
            agentBrowserCliArgs(args)[0] === 'batch'
              ? jsonResult({ success: true, data: { measured: 4 } })
              : snapshotPayload(),
          async () => await provider.snapshot({ includeRects: true }),
        ),
      refusedFor('batch-result-not-a-list'),
    );
  });
});

test('agent-browser provider refuses geometry when a batch entry is not an object', async () => {
  // Right number of answers, one of them not an object at all. A member that is not an object never
  // reaches the echo check, so only the shape guard can refuse it.
  await withWebProvider(async (provider) => {
    await assert.rejects(
      () =>
        withCommandExecutorOverride(
          async (_cmd, args, options) => {
            if (agentBrowserCliArgs(args)[0] !== 'batch') return snapshotPayload();
            const commands = readBatchCommands(options.stdin);
            return jsonResult(
              commands.map((command, index) =>
                index === 0
                  ? null
                  : { command, success: true, error: null, result: boxRect(command[2]) },
              ),
              1,
            );
          },
          async () => await provider.snapshot({ includeRects: true }),
        ),
      refusedFor('entry-shape'),
    );
  });
});

test('agent-browser provider refuses geometry when a batch entry carries no verdict', async () => {
  // An entry that echoes the right command and carries a box but states no `success` is the shape
  // the echo check cannot catch: it passes the echo and would be read as an ordinary failed ref,
  // dropping that node's geometry with no error so it reads as "this element has no box". Only the
  // shape guard's boolean-`success` clause refuses it.
  await withWebProvider(async (provider) => {
    await assert.rejects(
      () =>
        withCommandExecutorOverride(
          async (_cmd, args, options) => {
            if (agentBrowserCliArgs(args)[0] !== 'batch') return snapshotPayload();
            const commands = readBatchCommands(options.stdin);
            return jsonResult(
              commands.map((command, index) =>
                // index 0 echoes the command it answers (`command` IS `commands[0]` there) and
                // carries a plausible box, so only the missing `success` distinguishes it.
                index === 0
                  ? { command, result: boxRect(command[2]) }
                  : { command, success: true, error: null, result: boxRect(command[2]) },
              ),
              1,
            );
          },
          async () => await provider.snapshot({ includeRects: true }),
        ),
      refusedFor('entry-shape'),
    );
  });
});

test('agent-browser provider refuses geometry when an entry echoes a different command', async () => {
  // The entries arrive in the order the commands were sent, so position alone would pair them. The
  // echo is the proof that an entry really describes the ref it is paired with: a backend that
  // reorders or answers a command it did not receive would otherwise hand each node another node's
  // box, which reads as a working capture with wrong geometry.
  await withWebProvider(async (provider) => {
    await assert.rejects(
      () =>
        withCommandExecutorOverride(
          async (_cmd, args, options) => {
            if (agentBrowserCliArgs(args)[0] !== 'batch') return snapshotPayload();
            const commands = readBatchCommands(options.stdin);
            return jsonResult(
              commands.map((command, index) => ({
                command: commands[(index + 1) % commands.length],
                success: true,
                error: null,
                result: boxRect(command[2]),
              })),
              1,
            );
          },
          async () => await provider.snapshot({ includeRects: true }),
        ),
      refusedFor('entry-command'),
    );
  });
});

test('agent-browser provider refuses geometry when the batch itself faults', async () => {
  // A whole-batch fault comes back as one envelope rather than one entry per command, so nothing can
  // be paired back to a ref; the refusal is the typed one the envelope carries.
  await withWebProvider(async (provider) => {
    await assert.rejects(
      () =>
        withCommandExecutorOverride(
          async (_cmd, args) =>
            agentBrowserCliArgs(args)[0] === 'batch'
              ? jsonResult({ success: false, error: 'Invalid JSON input' }, 1)
              : snapshotPayload(),
          async () => await provider.snapshot({ includeRects: true }),
        ),
      (error: unknown) => error instanceof AppError && error.code === 'COMMAND_FAILED',
    );
  });
});

test('agent-browser provider surfaces a stale ref as a refusal of the geometry it was asked for', async () => {
  await withWebProvider(async (provider) => {
    await assert.rejects(
      () =>
        withCommandExecutorOverride(
          async (_cmd, args) =>
            agentBrowserCliArgs(args)[0] === 'batch'
              ? jsonResult({ success: false, error: 'Stale ref @e1' }, 1)
              : jsonResult({
                  success: true,
                  data: {
                    refs: { e1: { role: 'button', name: 'Save' } },
                    snapshot: 'button "Save" [ref=e1]',
                  },
                }),
          async () => await provider.snapshot({ includeRects: true }),
        ),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'COMMAND_FAILED' &&
        error.message === 'Stale ref @e1',
    );
  });
});

test('agent-browser provider passes snapshot cancellation to the geometry batch', async () => {
  // The batch is the call that now carries up to 200 commands, so it is the one where a dropped
  // signal costs a whole 30 s after the caller gave up. The capture call has its own test; this is
  // the geometry half.
  const controller = new AbortController();
  await withWebProvider(async (provider) => {
    const signals: Array<AbortSignal | undefined> = [];
    await withCommandExecutorOverride(
      async (_cmd, args, options) => {
        signals.push(options.signal);
        if (agentBrowserCliArgs(args)[0] !== 'batch') return snapshotPayload();
        const commands = readBatchCommands(options.stdin);
        return jsonResult(
          commands.map((command) => ({
            command,
            success: true,
            error: null,
            result: boxRect(command[2]),
          })),
        );
      },
      async () => await provider.snapshot({ includeRects: true, signal: controller.signal }),
    );
    assert.equal(signals.length, 2, 'one capture call and one geometry batch');
    assert.equal(
      signals[1],
      controller.signal,
      'the geometry batch is cancellable by the request that asked for it',
    );
  });
});

test('agent-browser provider asks the backend nothing for a capture of only ref-less text', async () => {
  // A capture of only ref-less text has no box to ask for. Declining is the fetcher's decision, and
  // pinning it here is what keeps the all-unmeasurable refusal from firing on an empty tree.
  await withWebProvider(async (provider) => {
    const calls: AgentBrowserCall[] = [];
    const snapshot = await withCommandExecutorOverride(
      async (cmd, args) => {
        recordCall(calls, cmd, args);
        return jsonResult({
          success: true,
          data: { refs: {}, snapshot: '- status "Hello Zed"', truncated: false },
        });
      },
      async () => await provider.snapshot({ includeRects: true }),
    );

    assert.deepEqual(
      calls.map((call) => call.args[0]),
      ['snapshot'],
      'no batch is sent when nothing in the capture has a ref',
    );
    assert.equal(snapshot.nodes.length, 1);
    assert.equal(snapshot.nodes[0]?.ref, undefined);
  });
});

async function withWebProvider(
  testFn: (provider: ReturnType<typeof createAgentBrowserWebProvider>) => void | Promise<void>,
): Promise<void> {
  const stateDir = mkdtempForTestSync('agent-device-web-provider-rects-');
  try {
    installFakeManagedAgentBrowser(stateDir);
    await testFn(createAgentBrowserWebProvider({ stateDir, session: 'web-session' }));
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

/**
 * The backend answers a geometry batch with one entry per command, and a ref it cannot measure comes
 * back as a failed entry rather than a failed batch: `@e3` of this fixture is the element with no
 * box. `@e1`/`@e2`/`@e4` report the boxes `boxRect` describes.
 */
function geometryExecutor(calls: AgentBrowserCall[]) {
  return async (
    cmd: string,
    args: readonly string[],
    options: { allowFailure?: boolean; stdin?: string | Buffer },
  ): Promise<ExecResult> => {
    const cliArgs = recordCall(calls, cmd, args, options.stdin);
    if (cliArgs[0] === 'snapshot') return snapshotPayload();
    if (cliArgs[0] === 'batch') {
      const commands = readBatchCommands(options.stdin);
      assert.equal(options.allowFailure, true);
      assert.ok(!cliArgs.includes('--bail'), 'a bailed batch drops the refs after a failed one');
      return jsonResult(
        commands.map((command) =>
          command.slice(0, 3).join(' ') === 'get box @e3'
            ? { command, success: false, error: 'No box for element', result: null }
            : { command, success: true, error: null, result: boxRect(command[2]) },
        ),
        1,
      );
    }
    return jsonResult({ success: true, data: {} });
  };
}

function assertGeometryRects(snapshot: WebSnapshotResult): void {
  assert.deepEqual(
    snapshot.nodes.map((node) => node.rect),
    [
      { x: 1, y: 2, width: 100, height: 20 },
      { x: 11, y: 12, width: 100, height: 20 },
      undefined,
      { x: 31, y: 32, width: 100, height: 20 },
    ],
  );
}

/**
 * The refusal this file is about, pinned to the invariant that broke. Every branch below shares the
 * message prefix, so matching the prefix alone would let any of them satisfy any of these tests.
 */
function refusedFor(reason: string) {
  return (error: unknown) =>
    error instanceof AppError &&
    error.code === 'COMMAND_FAILED' &&
    error.details?.reason === reason;
}

/** The commands the provider wrote for one `batch`, which is the shape this file is about. */
function readBatchCommands(stdin: string | Buffer | undefined): string[][] {
  assert.equal(typeof stdin, 'string', 'batch reads its commands from stdin');
  return JSON.parse(String(stdin)) as string[][];
}

function recordCall(
  calls: AgentBrowserCall[],
  cmd: string,
  args: readonly string[],
  stdin?: string | Buffer,
): string[] {
  const cliArgs = agentBrowserCliArgs(args);
  const written = typeof stdin === 'string' ? stdin : undefined;
  calls.push({ cmd, args: cliArgs, ...(written === undefined ? {} : { stdin: written }) });
  return cliArgs;
}

/**
 * The backend runs as `node <entry> <agent-browser args>`; that shape is owned and asserted by
 * agent-browser-tool. Here it is only stripped, so these tests read as the CLI arguments they are
 * about.
 */
function agentBrowserCliArgs(args: readonly string[]): string[] {
  return args.slice(1);
}

/** A capture of `count` addressable nodes, to exercise a page bigger than one batch group. */
function manyRefSnapshotPayload(count: number): ExecResult {
  const refs: Record<string, { role: string; name: string }> = {};
  const lines: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    refs[`e${index}`] = { role: 'button', name: `Item ${index}` };
    lines.push(`- button "Item ${index}" [ref=e${index}]`);
  }
  return jsonResult({ success: true, data: { refs, snapshot: lines.join('\n') } });
}

function snapshotPayload(): ExecResult {
  return jsonResult({
    success: true,
    data: {
      refs: {
        e1: { role: 'heading', name: 'Welcome' },
        e2: { role: 'textbox', name: 'Name' },
        e3: { role: 'button', name: 'Save' },
        e4: { role: 'link', name: 'Docs' },
      },
      snapshot: [
        '- heading "Welcome" [ref=e1]',
        '  - textbox "Name" [ref=e2]: Ada',
        '  - button "Save" [ref=e3]',
        '  - link "Docs" [ref=e4]',
      ].join('\n'),
      truncated: false,
    },
  });
}

/** The box the backend reports for a ref, as a batch entry carries it inline. */
function boxRect(ref: string | undefined): { x: number; y: number; width: number; height: number } {
  const offset = ref === '@e1' ? 0 : ref === '@e2' ? 10 : 30;
  return { x: offset + 1, y: offset + 2, width: 100, height: 20 };
}

function jsonResult(value: unknown, exitCode = 0): ExecResult {
  return { stdout: JSON.stringify(value), stderr: '', exitCode };
}
