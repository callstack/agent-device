import { spawnSync } from 'node:child_process';

export type GuestProcessSample = Readonly<{ cpuMs: number; memoryBytes: number }>;

export function readGuestProcessSample(socketPath: string): GuestProcessSample | undefined {
  const found = spawnSync(
    'pgrep',
    ['-f', `SimulatorFrameworkBridge accessibility serve ${socketPath}`],
    { encoding: 'utf8' },
  );
  const samples = (found.stdout ?? '')
    .split('\n')
    .map((value) => Number(value.trim()))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
    .flatMap(readProcessSample);
  if (samples.length === 0) return undefined;
  return {
    cpuMs: samples.reduce((total, sample) => total + sample.cpuMs, 0),
    memoryBytes: samples.reduce((maximum, sample) => Math.max(maximum, sample.memoryBytes), 0),
  };
}

export function processUsageDelta(
  before: GuestProcessSample | undefined,
  after: GuestProcessSample | undefined,
): GuestProcessSample | undefined {
  if (!after) return undefined;
  return {
    cpuMs: Math.max(0, after.cpuMs - (before?.cpuMs ?? 0)),
    memoryBytes: after.memoryBytes,
  };
}

export function parseProcessTime(value: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/u.exec(value.trim());
  if (!match) return undefined;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1_000;
}

function readProcessSample(pid: number): GuestProcessSample[] {
  const result = spawnSync('ps', ['-o', 'time=', '-o', 'rss=', '-o', 'args=', '-p', String(pid)], {
    encoding: 'utf8',
  });
  const fields = (result.stdout ?? '').trim().split(/\s+/u);
  if (!fields[2]?.endsWith('SimulatorFrameworkBridge')) return [];
  const cpuMs = parseProcessTime(fields[0] ?? '');
  const memoryKb = Number(fields[1]);
  return cpuMs === undefined || !Number.isFinite(memoryKb) || memoryKb < 0
    ? []
    : [{ cpuMs, memoryBytes: memoryKb * 1_024 }];
}
