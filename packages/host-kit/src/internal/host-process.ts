import type { ExecOptions, ExecResult } from './exec.ts';
import { runCmd, runCmdSync, withoutCommandExecutorOverride } from './exec.ts';
import { sleep } from './retry.ts';

const PS_TIMEOUT_MS = 1_000;
// The one binary behind every POSIX probe: pinning it keeps a hostile PATH from
// substituting another `ps`. Windows hosts branch to the CIM query at every call
// site before this constant is consulted, so it names no Windows tool.
const HOST_PS_COMMAND = '/bin/ps';
// PowerShell pays a fixed startup cost before the CIM query even runs, so every
// Windows process-table read gets at least this budget instead of the `ps` one.
const WINDOWS_PS_TIMEOUT_MS = 2_000;
const WINDOWS_PROCESS_TOOL = 'powershell.exe';

export type HostProcessInfo = {
  pid: number;
  ppid?: number;
  command: string;
};

export type HostProcessIdentityObservation = Readonly<{
  state: string;
  startTime: string;
}>;

/**
 * What the host says about one pid when a caller is about to signal it. Each field is `null`
 * when the host did not answer, which is unknown evidence rather than absence: only a `ps`
 * that names a different process proves the pid changed hands. `zombie` is `null` together
 * with an unreadable process state, since a zombie passes `kill(pid, 0)` and still reports
 * its original start time, so nothing else exposes that it already terminated.
 */
export type HostProcessIdentityFacts = Readonly<{
  startTime: string | null;
  command: string | null;
  zombie: boolean | null;
}>;

type HostProcessRunCommand = (
  cmd: string,
  args: string[],
  options: ExecOptions,
) => Promise<ExecResult>;

export function hostEnvironment(): NodeJS.ProcessEnv {
  return process.env;
}

export function readHostEnvironmentVariable(name: string): string | undefined {
  return hostEnvironment()[name];
}

export function writeHostStderr(value: string): void {
  process.stderr.write(value);
}

export function hostCurrentWorkingDirectory(): string {
  return process.cwd();
}

export function hostNodeExecutablePath(): string {
  return process.execPath;
}

export function hostNodeVersion(): string {
  return process.version;
}

export function hostPlatform(): NodeJS.Platform {
  return process.platform;
}

export function hostProcessId(): number {
  return process.pid;
}

export type ListHostProcessesOptions = {
  timeoutMs: number;
  runCommand?: HostProcessRunCommand;
};

export type StopPidsWithEscalationOptions = {
  pids: readonly number[];
  termTimeoutMs: number;
  killTimeoutMs: number;
};

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function isProcessGroupAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Reads who owns a pid, off the event loop, with a budget the caller names. The three fields
 * are read concurrently so a loaded host pays one budget for the set rather than one per
 * field; on Windows one CIM query answers the whole set. Use this rather than the synchronous
 * probes when the answer decides whether a process is signaled: waiting is reversible and
 * signaling the wrong process is not.
 */
export async function readProcessIdentityFacts(
  pid: number,
  timeoutMs = PS_TIMEOUT_MS,
): Promise<HostProcessIdentityFacts> {
  if (isWindowsHostPlatform()) {
    return await readWindowsProcessIdentityFacts(pid, timeoutMs);
  }
  const [startTime, command, state] = await Promise.all([
    readProcessFieldAsync(pid, 'lstart=', timeoutMs),
    readProcessFieldAsync(pid, 'command=', timeoutMs),
    readProcessFieldAsync(pid, 'state=', timeoutMs),
  ]);
  return { startTime, command, zombie: state === null ? null : state.startsWith('Z') };
}

export function readProcessStartTime(pid: number): string | null {
  return readProcessField(pid, 'lstart=');
}

export function readProcessCommand(pid: number): string | null {
  return readProcessField(pid, 'command=');
}

// A terminated Windows process leaves the CIM table rather than lingering in it
// unreaped, so no live pid on that host can be a zombie: the question is answered
// without a process-table probe, and exit proof stays liveness-and-lifetime.
export function isProcessZombie(pid: number): boolean {
  if (isWindowsHostPlatform()) return false;
  return readProcessField(pid, 'state=')?.startsWith('Z') ?? false;
}

/**
 * What the host says about each pid named, from one process-tool snapshot. An unanswered pid is
 * missing from the map, which is unknown evidence rather than absence: a caller that signals on
 * the answer must stay fail-closed. Use {@link readHostProcessIdentityObservationsAsync} from a
 * path that is already waiting; this one blocks the event loop for the whole snapshot.
 */
export function readHostProcessIdentityObservations(
  pids: Iterable<number>,
): ReadonlyMap<number, HostProcessIdentityObservation> {
  const selected = uniquePositivePids(pids);
  if (selected.length === 0) return new Map();
  return readHostProcessIdentitySnapshot(selected, readHostProcessIdentityRowsSync(selected));
}

/**
 * {@link readHostProcessIdentityObservations} off the event loop, with the same one-snapshot
 * guarantee and the same fail-closed answer. A daemon request path that only decides whether to
 * pay a cost must not stall every other request, timer, and abort handler behind a
 * `spawnSync` of the host process tool.
 */
export async function readHostProcessIdentityObservationsAsync(
  pids: Iterable<number>,
): Promise<ReadonlyMap<number, HostProcessIdentityObservation>> {
  const selected = uniquePositivePids(pids);
  if (selected.length === 0) return new Map();
  // What a host says about a pid is never a toolchain command to route elsewhere, so the
  // snapshot leaves the executor scope the way the synchronous probe already ignores it.
  const rows = await withoutCommandExecutorOverride(() =>
    readHostProcessIdentityRowsAsync(selected),
  );
  return readHostProcessIdentitySnapshot(selected, rows);
}

function readHostProcessIdentitySnapshot(
  pids: Iterable<number>,
  rows: readonly HostProcessIdentityRow[],
): ReadonlyMap<number, HostProcessIdentityObservation> {
  const selected = uniquePositivePids(pids);
  const observations = new Map<number, HostProcessIdentityObservation>();
  if (selected.length === 0 || rows.length === 0) return observations;
  const named = new Set(selected);
  for (const row of rows) {
    // A live row is never a zombie on Windows, and a zombie keeps its recorded start time, so
    // the row the process tool answers is where both facts are.
    if (!named.has(row.pid)) continue;
    observations.set(row.pid, { state: row.state, startTime: row.startTime });
  }
  return observations;
}

type HostProcessIdentityRow = Readonly<{ pid: number; state: string; startTime: string }>;

const HOST_PROCESS_IDENTITY_PS_ARGS = (pids: readonly number[]): string[] => [
  '-p',
  pids.join(','),
  '-o',
  'pid=,state=,lstart=',
];

function readHostProcessIdentityRowsSync(
  pids: readonly number[],
): readonly HostProcessIdentityRow[] {
  if (isWindowsHostPlatform()) {
    return windowsProcessIdentityRows(readWindowsProcessRows(pids, WINDOWS_PS_TIMEOUT_MS));
  }
  try {
    const result = runCmdSync(HOST_PS_COMMAND, HOST_PROCESS_IDENTITY_PS_ARGS(pids), {
      allowFailure: true,
      timeoutMs: PS_TIMEOUT_MS,
    });
    return result.exitCode !== 0 ? [] : parseHostProcessIdentityRows(result.stdout);
  } catch {
    // A failed ps snapshot is unknown evidence; callers remain fail-closed.
    return [];
  }
}

async function readHostProcessIdentityRowsAsync(
  pids: Iterable<number>,
): Promise<readonly HostProcessIdentityRow[]> {
  const selected = uniquePositivePids(pids);
  if (selected.length === 0) return [];
  if (isWindowsHostPlatform()) {
    return windowsProcessIdentityRows(
      await readWindowsProcessRowsAsync(selected, WINDOWS_PS_TIMEOUT_MS),
    );
  }
  try {
    const result = await runCmd(HOST_PS_COMMAND, HOST_PROCESS_IDENTITY_PS_ARGS(selected), {
      allowFailure: true,
      timeoutMs: PS_TIMEOUT_MS,
    });
    return result.exitCode !== 0 ? [] : parseHostProcessIdentityRows(result.stdout);
  } catch {
    return [];
  }
}

function parseHostProcessIdentityRows(stdout: string): HostProcessIdentityRow[] {
  const rows: HostProcessIdentityRow[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1]!, 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    rows.push({ pid, state: match[2]!, startTime: match[3]! });
  }
  return rows;
}

function windowsProcessIdentityRows(
  rows: readonly WindowsProcessRow[],
): readonly HostProcessIdentityRow[] {
  return rows.flatMap((row) =>
    // A terminated Windows process leaves the CIM table rather than lingering in it unreaped,
    // so no live row can be a zombie: exit proof stays liveness-and-lifetime.
    row.startTime === null ? [] : [{ pid: row.pid, state: 'R', startTime: row.startTime }],
  );
}

type HostProcessField = 'lstart=' | 'command=' | 'state=';

function readProcessField(pid: number, field: HostProcessField): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (isWindowsHostPlatform()) return readWindowsProcessField(pid, field);
  try {
    const result = runCmdSync(HOST_PS_COMMAND, ['-p', String(pid), '-o', field], {
      allowFailure: true,
      timeoutMs: PS_TIMEOUT_MS,
    });
    return processFieldValue(result);
  } catch {
    return null;
  }
}

async function readProcessFieldAsync(
  pid: number,
  field: HostProcessField,
  timeoutMs: number,
): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const result = await runCmd(HOST_PS_COMMAND, ['-p', String(pid), '-o', field], {
      allowFailure: true,
      timeoutMs,
    });
    return processFieldValue(result);
  } catch {
    return null;
  }
}

function processFieldValue(result: ExecResult): string | null {
  if (result.exitCode !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

/**
 * Walks process-table stdout line by line, keeping rows whose first two
 * capture groups are a positive pid and an optional positive ppid. Every
 * process-table format (POSIX `ps`, Windows CIM) feeds its own row pattern
 * and row builder through this single walk.
 */
function parseProcessTableRows<T>(
  stdout: string,
  rowPattern: RegExp,
  build: (match: RegExpExecArray, pid: number, ppid: number | undefined) => T,
): T[] {
  const rows: T[] = [];
  for (const line of stdout.replace(/^\uFEFF/, '').split('\n')) {
    const match = rowPattern.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1]!, 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const ppid = Number.parseInt(match[2]!, 10);
    rows.push(build(match, pid, Number.isInteger(ppid) && ppid > 0 ? ppid : undefined));
  }
  return rows;
}

export function parseHostProcessList(stdout: string): HostProcessInfo[] {
  return parseProcessTableRows(stdout, /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/, (match, pid, ppid) => ({
    pid,
    ppid,
    command: match[3]!,
  }));
}

/* -------------------------------------------------------------------------- */
/* Windows process-identity branch (#3291)                                     */
/*                                                                             */
/* Windows hosts have no `ps`. The same identity facts come from one           */
/* CIM (`Win32_Process`) query through PowerShell: `CreationDate` is the       */
/* birth time proven against PID reuse, `CommandLine` is the command the       */
/* daemon-identity patterns match, and a terminated process leaves the table   */
/* entirely instead of lingering as a zombie, so a live row is never `Z`.      */
/* A failed or unanswered query is unknown evidence, exactly like a failed     */
/* `ps`, and every caller stays fail-closed on it.                             */
/* -------------------------------------------------------------------------- */

type WindowsProcessRow = Readonly<{
  pid: number;
  ppid?: number;
  startTime: string | null;
  command: string | null;
}>;

function isWindowsHostPlatform(): boolean {
  return hostPlatform() === 'win32';
}

// Rows are `pid|ppid|creation|command`. The creation stamp is formatted with
// the invariant culture, so the value recorded in daemon.json compares equal
// on every read of the same process lifetime regardless of host locale. The
// row rule is that a null field prints empty and never raises: the CIM table
// carries rows without a CreationDate (the System Idle Process), and a
// terminating error mid-pipeline would exit 1 and blank the whole snapshot
// instead of that one row. Newlines inside a command line are flattened so
// one process is one row; the command may still contain `|`, which only ever
// lands in the final capture group.
const WINDOWS_PROCESS_ROW_BODY =
  ' | ForEach-Object {' +
  ' $birth = if ($_.CreationDate) {' +
  " $_.CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmssfffffff'," +
  ' [System.Globalization.CultureInfo]::InvariantCulture)' +
  " } else { '' };" +
  " '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, $birth," +
  String.raw` ($_.CommandLine -replace '[\r\n]+', ' ') }`;

function windowsProcessQueryArgs(pids: readonly number[]): string[] {
  const source =
    pids.length > 0
      ? `Get-CimInstance -ClassName Win32_Process -Filter '${pids
          .map((pid) => `ProcessId=${pid}`)
          .join(' OR ')}'`
      : 'Get-CimInstance -ClassName Win32_Process';
  // PowerShell writes redirected stdout in the OEM console code page, which would
  // mojibake any non-ASCII command line the identity check later compares
  // byte-for-byte; the console is pinned to UTF-8 so the pipe matches the
  // UTF-8 decode Node applies.
  const command = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${source}${WINDOWS_PROCESS_ROW_BODY}`;
  return ['-NoProfile', '-NonInteractive', '-Command', command];
}

function parseWindowsProcessRows(stdout: string): WindowsProcessRow[] {
  return parseProcessTableRows(
    stdout,
    /^(\d+)\|(\d+)\|([^|]*)\|(.*)\r?$/,
    (match, pid, ppid): WindowsProcessRow => ({
      pid,
      ...(ppid !== undefined ? { ppid } : {}),
      startTime: match[3]!.length > 0 ? match[3]! : null,
      command: match[4]!.length > 0 ? match[4]! : null,
    }),
  );
}

function readWindowsProcessRows(pids: readonly number[], timeoutMs: number): WindowsProcessRow[] {
  try {
    const result = runCmdSync(WINDOWS_PROCESS_TOOL, windowsProcessQueryArgs(pids), {
      allowFailure: true,
      timeoutMs,
    });
    if (result.exitCode !== 0) return [];
    return parseWindowsProcessRows(result.stdout);
  } catch {
    // A failed CIM snapshot is unknown evidence; callers remain fail-closed.
    return [];
  }
}

async function readWindowsProcessRowsAsync(
  pids: readonly number[],
  timeoutMs: number,
): Promise<WindowsProcessRow[]> {
  try {
    const result = await runCmd(WINDOWS_PROCESS_TOOL, windowsProcessQueryArgs(pids), {
      allowFailure: true,
      timeoutMs,
    });
    if (result.exitCode !== 0) return [];
    return parseWindowsProcessRows(result.stdout);
  } catch {
    return [];
  }
}

function readWindowsProcessField(pid: number, field: HostProcessField): string | null {
  const row = readWindowsProcessRows([pid], WINDOWS_PS_TIMEOUT_MS).find(
    (candidate) => candidate.pid === pid,
  );
  if (!row) return null;
  if (field === 'lstart=') return row.startTime;
  if (field === 'command=') return row.command;
  return 'R';
}

function windowsBudgetMs(timeoutMs: number): number {
  return Math.max(timeoutMs, WINDOWS_PS_TIMEOUT_MS);
}

async function readWindowsProcessIdentityFacts(
  pid: number,
  timeoutMs: number,
): Promise<HostProcessIdentityFacts> {
  if (!Number.isInteger(pid) || pid <= 0) return { startTime: null, command: null, zombie: null };
  try {
    const result = await runCmd(WINDOWS_PROCESS_TOOL, windowsProcessQueryArgs([pid]), {
      allowFailure: true,
      timeoutMs: windowsBudgetMs(timeoutMs),
    });
    if (result.exitCode !== 0) return { startTime: null, command: null, zombie: null };
    const row = parseWindowsProcessRows(result.stdout).find((candidate) => candidate.pid === pid);
    if (!row) return { startTime: null, command: null, zombie: null };
    return { startTime: row.startTime, command: row.command, zombie: false };
  } catch {
    return { startTime: null, command: null, zombie: null };
  }
}

async function listWindowsHostProcesses(
  options: ListHostProcessesOptions,
): Promise<HostProcessInfo[]> {
  const result = await (options.runCommand ?? runCmd)(
    WINDOWS_PROCESS_TOOL,
    windowsProcessQueryArgs([]),
    {
      allowFailure: true,
      timeoutMs: windowsBudgetMs(options.timeoutMs),
    },
  );
  if (result.exitCode !== 0) return [];
  return parseWindowsProcessRows(result.stdout).map((row) => ({
    pid: row.pid,
    ...(row.ppid !== undefined ? { ppid: row.ppid } : {}),
    command: row.command ?? '',
  }));
}

export async function listHostProcesses(
  options: ListHostProcessesOptions,
): Promise<HostProcessInfo[]> {
  if (isWindowsHostPlatform()) return await listWindowsHostProcesses(options);
  const result = await (options.runCommand ?? runCmd)(
    options.runCommand ? 'ps' : HOST_PS_COMMAND,
    ['-ax', '-o', 'pid=,ppid=,command='],
    {
      allowFailure: true,
      timeoutMs: options.timeoutMs,
    },
  );
  if (result.exitCode !== 0) return [];
  return parseHostProcessList(result.stdout);
}

export function expandProcessTree(
  rootPids: readonly number[],
  processes: readonly HostProcessInfo[],
): HostProcessInfo[] {
  const selected = new Set(uniquePositivePids(rootPids));
  let changed = true;
  while (changed) {
    changed = false;
    for (const processInfo of processes) {
      if (processInfo.ppid === undefined || !selected.has(processInfo.ppid)) continue;
      if (selected.has(processInfo.pid)) continue;
      selected.add(processInfo.pid);
      changed = true;
    }
  }
  return processes.filter((processInfo) => selected.has(processInfo.pid));
}

export function uniquePositivePids(
  values: Iterable<number>,
  options: { excludePid?: number } = {},
): number[] {
  return [...new Set(values)].filter(
    (pid) => Number.isInteger(pid) && pid > 0 && pid !== options.excludePid,
  );
}

export function signalPidsBestEffort(
  pidsToSignal: readonly number[],
  signal: NodeJS.Signals,
): number {
  const pids = uniquePositivePids(pidsToSignal, { excludePid: process.pid });
  let signaled = 0;
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
      signaled += 1;
    } catch {
      // Process already exited or cannot be signaled; cleanup remains best-effort.
    }
  }
  return signaled;
}

export async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  if (!isProcessAlive(pid)) return true;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(50);
    if (!isProcessAlive(pid)) return true;
  }
  return !isProcessAlive(pid);
}

export async function stopPidsWithEscalation(
  options: StopPidsWithEscalationOptions,
): Promise<void> {
  const pids = uniquePositivePids(options.pids, { excludePid: process.pid });
  if (pids.length === 0) return;
  signalPidsBestEffort(pids, 'SIGTERM');
  await Promise.all(pids.map(async (pid) => await waitForProcessExit(pid, options.termTimeoutMs)));
  const livePids = pids.filter((pid) => isProcessAlive(pid));
  signalPidsBestEffort(livePids, 'SIGKILL');
  await Promise.all(pids.map(async (pid) => await waitForProcessExit(pid, options.killTimeoutMs)));
}

const SYSCTL_TIMEOUT_MS = 1_000;
const APPLE_SILICON_SYSCTL = ['-n', 'hw.optional.arm64'] as const;

let pendingHostCpuArch: Promise<string> | undefined;
let settledHostCpuArch: string | undefined;

/**
 * The machine's native CPU architecture in Apple naming (`arm64`, `x86_64`), which is what
 * simulators on a Mac run by default. Other CPUs keep Node's `process.arch` name. Resolved once
 * per process.
 */
export function readHostCpuArch(): Promise<string> {
  if (settledHostCpuArch !== undefined) return Promise.resolve(settledHostCpuArch);
  pendingHostCpuArch ??= resolveHostCpuArch(process.platform, process.arch).then(settleHostCpuArch);
  return pendingHostCpuArch;
}

/**
 * {@link readHostCpuArch} for a caller that cannot await. It shares the same per-process value,
 * resolving it with a blocking `sysctl` only when nothing has resolved it yet.
 */
export function readHostCpuArchSync(): string {
  return (
    settledHostCpuArch ??
    settleHostCpuArch(
      hostCpuArchName(process.platform === 'darwin' && isAppleSiliconMacSync(), process.arch),
    )
  );
}

function settleHostCpuArch(arch: string): string {
  settledHostCpuArch ??= arch;
  return settledHostCpuArch;
}

export async function resolveHostCpuArch(
  platform: NodeJS.Platform,
  nodeArch: string,
): Promise<string> {
  return hostCpuArchName(platform === 'darwin' && (await isAppleSiliconMac()), nodeArch);
}

function hostCpuArchName(appleSilicon: boolean, nodeArch: string): string {
  if (appleSilicon) return 'arm64';
  return nodeArch === 'x64' ? 'x86_64' : nodeArch;
}

// macOS: `hw.optional.arm64` is 1 on Apple silicon even inside a Rosetta-translated process,
// where `process.arch` reports x64; Intel Macs do not define the key.
async function isAppleSiliconMac(): Promise<boolean> {
  try {
    const result = await runCmd('/usr/sbin/sysctl', APPLE_SILICON_SYSCTL, {
      allowFailure: true,
      timeoutMs: SYSCTL_TIMEOUT_MS,
    });
    return result.exitCode === 0 && result.stdout.trim() === '1';
  } catch {
    return false;
  }
}

function isAppleSiliconMacSync(): boolean {
  try {
    const result = runCmdSync('/usr/sbin/sysctl', APPLE_SILICON_SYSCTL, {
      allowFailure: true,
      timeoutMs: SYSCTL_TIMEOUT_MS,
    });
    return result.exitCode === 0 && result.stdout.trim() === '1';
  } catch {
    return false;
  }
}
