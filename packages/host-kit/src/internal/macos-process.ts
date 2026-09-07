import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCmdSync } from './exec.ts';

type MacosProcess = {
  pid: number;
  ppid: number;
  command: string;
  state: string;
  startTime: string;
};

function requirePrivatePath(path: string, kind: 'directory' | 'file'): void {
  const stat = lstatSync(path);
  const correctKind = kind === 'directory' ? stat.isDirectory() : stat.isFile();
  if (!correctKind || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new Error('macOS process helper path is not private and owned');
}

function compileHelper(source: string, directory: string, binary: string): void {
  const temporary = mkdtempSync(join(directory, 'compile-'));
  try {
    const output = join(temporary, 'process');
    const result = runCmdSync(
      '/usr/bin/clang',
      ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', output],
      { timeoutMs: 5_000, allowFailure: true },
    );
    if (result.exitCode !== 0) throw new Error('macOS process helper compilation failed');
    chmodSync(output, 0o700);
    renameSync(output, binary);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function helperPath(): string {
  const source = fileURLToPath(new URL('./macos-process.c', import.meta.url));
  const hash = createHash('sha256').update(readFileSync(source)).update(process.arch).digest('hex');
  const directory = join(tmpdir(), `agent-device-process-${process.getuid?.()}-${hash}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  requirePrivatePath(directory, 'directory');
  const binary = join(directory, 'process');
  if (!existsSync(binary)) compileHelper(source, directory, binary);
  requirePrivatePath(binary, 'file');
  return binary;
}

function psStartTime(seconds: number): string {
  const date = new Date(seconds * 1_000);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
  const month = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ][date.getMonth()];
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
  return `${day} ${month} ${String(date.getDate()).padStart(2, ' ')} ${time} ${date.getFullYear()}`;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
  );
}

function processArguments(value: Record<string, unknown>): string[] {
  if (!boundedInteger(value.argc, 0, 32_768)) throw new Error('invalid argument count');
  if (
    typeof value.argvHex !== 'string' ||
    value.argvHex.length > 65_536 ||
    !/^(?:[a-f0-9]{2})*$/.test(value.argvHex)
  )
    throw new Error('invalid argument bytes');
  const bytes = Buffer.from(value.argvHex, 'hex');
  const decoded = bytes.toString('utf8');
  if (!Buffer.from(decoded).equals(bytes)) throw new Error('invalid argument encoding');
  const args = decoded.split('\0');
  if (args.pop() !== '' || args.length !== value.argc)
    throw new Error('invalid argument boundaries');
  if (value.zombie ? args.length !== 0 : !args[0]) throw new Error('invalid process arguments');
  return args;
}

function processObservation(line: string): MacosProcess {
  if (line.length > 66_000) throw new Error('process observation is oversized');
  const value = JSON.parse(line);
  if (!boundedInteger(value.pid, 1, 2_147_483_647) || !boundedInteger(value.ppid, 0, 2_147_483_647))
    throw new Error('invalid process identity');
  if (typeof value.zombie !== 'boolean') throw new Error('invalid process state');
  if (
    typeof value.startSeconds !== 'string' ||
    !/^[1-9]\d{0,10}$/.test(value.startSeconds) ||
    !boundedInteger(value.startMicros, 0, 999_999)
  )
    throw new Error('invalid process start time');
  return {
    pid: value.pid,
    ppid: value.ppid,
    command: processArguments(value).join(' ').trim(),
    state: value.zombie ? 'Z' : 'S',
    startTime: psStartTime(Number(value.startSeconds)),
  };
}

export function readMacosProcesses(
  pids: readonly number[] | 'all',
  timeoutMs = 1_000,
): MacosProcess[] {
  if (process.platform !== 'darwin') return [];
  if (
    pids !== 'all' &&
    (pids.length === 0 ||
      pids.length > 1024 ||
      pids.some((pid) => !boundedInteger(pid, 1, 2_147_483_647)))
  )
    return [];
  try {
    const result = runCmdSync(helperPath(), pids === 'all' ? ['--all'] : pids.map(String), {
      timeoutMs,
      allowFailure: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.exitCode !== 0) return [];
    const observations = result.stdout.trim().split('\n').map(processObservation);
    if (pids !== 'all' && observations.some((value) => !pids.includes(value.pid))) return [];
    return observations;
  } catch {
    return [];
  }
}
