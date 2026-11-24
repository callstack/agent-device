import { beforeEach, expect, test, vi } from 'vitest';
import { readVersion } from '@agent-device/host-kit/version';
import { runCliProcess } from './process-entry.ts';
import { buildUsageText } from '../commands/schema/cli-help.ts';

const output = vi.hoisted(() => ({ stdout: [] as string[], stderr: [] as string[] }));
const exit = vi.hoisted(() => new Error('exit'));
vi.mock('./process-exit.ts', () => ({
  writeStdout: (text: string) => output.stdout.push(text),
  writeStderr: (text: string) => output.stderr.push(text),
  exitAfterFlush: async () => {
    throw exit;
  },
}));

const host = { cwd: process.cwd(), env: {} };
beforeEach(() => {
  output.stdout.length = 0;
  output.stderr.length = 0;
});

test.each([
  [['mcp', '--version'], `${readVersion()}\n`],
  [['--help', '--json'], `${buildUsageText()}\n`],
])('%j emits parsed output before loading CLI execution', async (argv, expected) => {
  const loadCli = vi.fn();
  await expect(runCliProcess(argv, host, loadCli)).rejects.toBe(exit);
  expect(loadCli).not.toHaveBeenCalled();
  expect(output.stdout.join('')).toContain(expected);
  expect(output.stderr).toEqual([]);
});

test.each([
  ['mcp', '--version', '--unknown'],
  ['connect', '--help', '--json'],
  ['mcp', '--structured', '--json'],
])('%j retains the full CLI path', async (...argv) => {
  const runCli = vi.fn();
  const loadCli = vi.fn(async () => ({ runCli }));
  await expect(runCliProcess(argv, host, loadCli)).rejects.toBe(exit);
  expect(runCli).toHaveBeenCalledWith(argv, undefined, host);
});

test('a malformed config from the captured environment retains the CLI error path', async () => {
  const capturedHost = { cwd: host.cwd, env: { AGENT_DEVICE_CONFIG: 'missing-config.json' } };
  const runCli = vi.fn();
  const loadCli = vi.fn(async () => ({ runCli }));
  await expect(runCliProcess(['mcp', '--version'], capturedHost, loadCli)).rejects.toBe(exit);
  expect(runCli).toHaveBeenCalledWith(['mcp', '--version'], undefined, capturedHost);
  expect(output.stdout).toEqual([]);
});
