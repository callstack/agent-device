import { Readable } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';
import { createAgentDeviceClient } from '../agent-device-client.ts';
import { parseArgs } from '../cli/parser/args.ts';
import type { DaemonRequest } from '@agent-device/kernel/contracts';
import { runCliCommandWithOutput } from './cli-runner.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Drives the real argv chain to the transport, with `text` piped to the process's stdin. */
async function runFillWithStdin(argv: string[], text: string): Promise<DaemonRequest[]> {
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from([text]) as typeof process.stdin);
  const seen: DaemonRequest[] = [];
  const client = createAgentDeviceClient(
    {},
    {
      transport: async (req) => {
        seen.push(req as DaemonRequest);
        return { ok: true, data: {} } as never;
      },
    },
  );
  const parsed = parseArgs(argv, { strictFlags: true });
  try {
    await runCliCommandWithOutput({
      client,
      command: 'fill',
      positionals: parsed.positionals,
      flags: parsed.flags,
    });
  } catch {
    // The stub's empty payload can fail result normalization after the request was captured.
  }
  return seen;
}

test('fill --text-stdin sends the piped text, not argv, and marks it for the daemon', async () => {
  const [request] = await runFillWithStdin(
    ['fill', 'id="password"', '--text-stdin'],
    'piped-secret\n',
  );

  expect(request?.command).toBe('fill');
  expect(request?.positionals).toEqual(['id="password"', 'piped-secret']);
  expect(request?.flags?.textStdin).toBe(true);
});

test('fill --text-stdin forwards --record-as with the piped text', async () => {
  const [request] = await runFillWithStdin(
    ['fill', '@e3', '--text-stdin', '--record-as', 'PASSWORD'],
    'piped-secret',
  );

  expect(request?.positionals).toEqual(['@e3', 'piped-secret']);
  expect(request?.flags?.recordAs).toBe('PASSWORD');
  expect(request?.flags?.textStdin).toBe(true);
});
