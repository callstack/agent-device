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

function helperPath(): string {
  const source = fileURLToPath(new URL('./macos-process.c', import.meta.url));
  const hash = createHash('sha256').update(readFileSync(source)).update(process.arch).digest('hex');
  const directory = join(tmpdir(), `agent-device-process-${process.getuid?.()}-${hash}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dirStat = lstatSync(directory);
  if (
    !dirStat.isDirectory() ||
    dirStat.uid !== process.getuid?.() ||
    (dirStat.mode & 0o077) !== 0
  ) {
    throw new Error('macOS process helper directory is not private');
  }
  const binary = join(directory, 'process');
  if (!existsSync(binary)) {
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
  const stat = lstatSync(binary);
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error('macOS process helper is not a private owned executable');
  }
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

export function readMacosProcesses(
  pids: readonly number[] | 'all',
  timeoutMs = 1_000,
): MacosProcess[] {
  if (process.platform !== 'darwin') return [];
  if (
    pids !== 'all' &&
    (pids.length === 0 ||
      pids.length > 1024 ||
      pids.some((pid) => !Number.isInteger(pid) || pid <= 0 || pid > 2_147_483_647))
  )
    return [];
  try {
    const result = runCmdSync(helperPath(), pids === 'all' ? ['--all'] : pids.map(String), {
      timeoutMs,
      allowFailure: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.exitCode !== 0) return [];
    const observations: MacosProcess[] = [];
    for (const line of result.stdout.trim().split('\n')) {
      if (line.length > 66_000) return [];
      const value = JSON.parse(line);
      if (
        !Number.isInteger(value.pid) ||
        value.pid <= 0 ||
        (pids !== 'all' && !pids.includes(value.pid)) ||
        !Number.isInteger(value.ppid) ||
        value.ppid < 0 ||
        typeof value.zombie !== 'boolean' ||
        typeof value.startSeconds !== 'string' ||
        !/^[1-9]\d{0,10}$/.test(value.startSeconds) ||
        !Number.isInteger(value.startMicros) ||
        value.startMicros < 0 ||
        value.startMicros >= 1_000_000 ||
        !Number.isInteger(value.argc) ||
        value.argc < 0 ||
        value.argc > 32_768 ||
        typeof value.argvHex !== 'string' ||
        value.argvHex.length > 65_536 ||
        !/^(?:[a-f0-9]{2})*$/.test(value.argvHex)
      )
        return [];
      const bytes = Buffer.from(value.argvHex, 'hex');
      const decoded = bytes.toString('utf8');
      if (!Buffer.from(decoded).equals(bytes)) return [];
      const args = decoded.split('\0');
      if (
        args.pop() !== '' ||
        args.length !== value.argc ||
        (value.zombie ? args.length !== 0 : !args[0])
      )
        return [];
      observations.push({
        pid: value.pid,
        ppid: value.ppid,
        command: args.join(' ').trim(),
        state: value.zombie ? 'Z' : 'S',
        startTime: psStartTime(Number(value.startSeconds)),
      });
    }
    return observations;
  } catch {
    return [];
  }
}
