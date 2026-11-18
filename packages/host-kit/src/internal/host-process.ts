import fs from 'node:fs';
import type { ExecOptions, ExecResult } from './exec.ts';
import { runCmd, runCmdSync, withoutCommandExecutorOverride } from './exec.ts';
import { sleep } from './retry.ts';
import type { EnvMap, HostEnvironment } from '@agent-device/kernel/source-value';

const PS_TIMEOUT_MS = 1_000;
// Every POSIX probe runs the first of these that exists, never a PATH lookup, so a hostile PATH
// cannot substitute another `ps`. NixOS keeps procps only in its root-owned system profile. With
// neither present, `/bin/ps` runs and fails closed. Windows hosts take the CIM query instead.
const HOST_PS_COMMANDS = ['/bin/ps', '/run/current-system/sw/bin/ps'] as const;
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

/** What the host says about one pid before a signal; `null` fields are unknown evidence, never absence. */
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

/** The process-shaped object an entry point captures: Node's `process` satisfies it. */
export type HostEnvironmentSource = Readonly<{
  env: EnvMap;
  cwd(): string;
}>;

/** Copies `source` (an entry point passes `process`) so later changes never reach the capture. */
export function captureHostEnvironment(source: HostEnvironmentSource): HostEnvironment {
  return { env: { ...source.env }, cwd: source.cwd() };
}

export function writeHostStderr(value: string): void {
  process.stderr.write(value);
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

function hostPsCommand(): string {
  for (const candidate of HOST_PS_COMMANDS) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return HOST_PS_COMMANDS[0];
}

export type ListHostProcessesOptions = {
  timeoutMs: number;
  runCommand?: HostProcessRunCommand;
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

/** Off-loop ownership read for answers that decide a signal; see {@link readProcessIdentities}. */
export async function readProcessIdentityFacts(
  pid: number,
  timeoutMs = PS_TIMEOUT_MS,
): Promise<HostProcessIdentityFacts> {
  return (await readProcessIdentities([pid], timeoutMs)).get(pid) ?? UNANSWERED_IDENTITY;
}

const UNANSWERED_IDENTITY: HostProcessIdentityFacts = Object.freeze({
  startTime: null,
  command: null,
  zombie: null,
});

/**
 * Off-loop facts for many pids from one shared process-table read set (POSIX ps pairs, Windows
 * CIM); unanswered pids map to all-`null` facts. Nothing about another process is cached.
 */
export async function readProcessIdentities(
  pids: Iterable<number>,
  timeoutMs = PS_TIMEOUT_MS,
): Promise<ReadonlyMap<number, HostProcessIdentityFacts>> {
  const selected = uniquePositivePids(pids);
  const facts = new Map<number, HostProcessIdentityFacts>();
  if (selected.length === 0) return facts;
  // What a host says about a pid is never a toolchain command to route elsewhere.
  const rows = await withoutCommandExecutorOverride(() =>
    readProcessIdentityRows(selected, timeoutMs),
  );
  for (const pid of selected) facts.set(pid, rows.get(pid) ?? UNANSWERED_IDENTITY);
  return facts;
}

async function readProcessIdentityRows(
  pids: readonly number[],
  timeoutMs: number,
): Promise<ReadonlyMap<number, HostProcessIdentityFacts>> {
  if (isWindowsHostPlatform()) {
    const rows = await readWindowsProcessRowsAsync(pids, windowsBudgetMs(timeoutMs));
    // A terminated Windows process leaves the CIM table rather than lingering unreaped.
    return new Map(
      rows.map((row) => [
        row.pid,
        { startTime: row.startTime, command: row.command, zombie: false },
      ]),
    );
  }
  const [identityRows, commandRows] = await Promise.all([
    runHostPsAsync(
      HOST_PROCESS_IDENTITY_PS_ARGS(pids),
      psLstartReadOptions(timeoutMs),
      parseHostProcessIdentityRows,
    ),
    runHostPsAsync(
      HOST_PROCESS_COMMAND_PS_ARGS(pids),
      psReadOptions(timeoutMs),
      parseHostProcessCommandRows,
    ),
  ]);
  const identities = new Map(identityRows.map((row) => [row.pid, row]));
  const commands = new Map(commandRows.map((row) => [row.pid, row.command]));
  const facts = new Map<number, HostProcessIdentityFacts>();
  for (const pid of pids) {
    const identity = identities.get(pid);
    const command = commands.get(pid) ?? null;
    if (!identity && command === null) continue;
    facts.set(pid, {
      startTime: identity?.startTime ?? null,
      command,
      zombie: identity ? identity.state.startsWith('Z') : null,
    });
  }
  return facts;
}

async function runHostPsAsync<Row>(
  args: string[],
  options: ExecOptions,
  parse: (stdout: string) => Row[],
): Promise<Row[]> {
  try {
    const result = await runCmd(hostPsCommand(), args, options);
    return result.exitCode !== 0 ? [] : parse(result.stdout);
  } catch {
    // A failed ps read is unknown evidence; callers remain fail-closed.
    return [];
  }
}

const HOST_PROCESS_COMMAND_PS_ARGS = (pids: readonly number[]): string[] => [
  '-p',
  pids.join(','),
  '-o',
  'pid=,command=',
];

function parseHostProcessCommandRows(stdout: string): Array<{ pid: number; command: string }> {
  return parseProcessTableRows(stdout, /^\s*(\d+)()\s+(.+?)\s*$/, (match, pid) => ({
    pid,
    command: match[3]!,
  }));
}

/** State and start token from one `/proc/<pid>/stat` read, so a reused pid cannot mix lifetimes. */
function readLinuxProcessStat(pid: number): { state: string; startTime: string } | null {
  if (process.platform !== 'linux') return null;
  try {
    const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm can contain spaces and closing parentheses; field 3 follows the last one.
    const end = stat.lastIndexOf(')');
    if (end < 0) return null;
    const fields = stat
      .slice(end + 1)
      .trim()
      .split(/\s+/);
    const state = fields[0];
    const startTime = fields[19];
    if (!bootId || !state || !startTime || !/^\d+$/.test(startTime)) return null;
    return { state, startTime: `linux:${bootId}:${startTime}` };
  } catch {
    return null;
  }
}

/**
 * Locale and clock pin for lstart-bearing ps reads, applied as a final `envOverrides` word so it
 * wins over any captured host or request `TZ` without replacing the rest of the child env. With
 * `TZ=UTC` the ps child renders lstart on the UTC clock no matter which zone the reader or the
 * bound request inherited, so the output is parsed as UTC and the token has no local-zone or DST
 * dependence.
 */
const PS_LSTART_ENV_OVERRIDES: NodeJS.ProcessEnv = { LC_ALL: 'C', TZ: 'UTC' };

/** ps read options without lstart: failure is unknown evidence; the caller's locale stays in charge. */
const psReadOptions = (timeoutMs: number): ExecOptions => ({ allowFailure: true, timeoutMs });

/** ps read options carrying lstart: C locale and UTC clock pinned over the effective child env. */
const psLstartReadOptions = (timeoutMs: number): ExecOptions => ({
  allowFailure: true,
  timeoutMs,
  envOverrides: PS_LSTART_ENV_OVERRIDES,
});

const WINDOWS_START_TIME = /^\d{21}$/; // Windows CIM stamp yyyyMMddHHmmssfffffff
const POSIX_BIRTH_TOKEN_PREFIX = 'posix:'; // canonical POSIX birth token: UTC epoch ms
// Raw C-form `ps -o lstart=` (historical records) is unqualified: no comparable provenance.
const PS_START_TIME_FIELDS =
  /^([A-Za-z]{3}) ([A-Za-z]{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;
const PS_MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');

type BirthTokenFormat = 'linux' | 'posix' | 'windows' | 'unqualified';

function psStartTimeFormat(value: string): BirthTokenFormat {
  if (value.startsWith('linux:')) return 'linux';
  if (value.startsWith(POSIX_BIRTH_TOKEN_PREFIX)) return 'posix';
  if (WINDOWS_START_TIME.test(value)) return 'windows';
  return 'unqualified';
}

/** A birth token with comparable provenance can prove or authorize a lifetime; a raw one cannot. */
export function isProvenancedBirthToken(value: string): boolean {
  return psStartTimeFormat(value) !== 'unqualified';
}

// Differ proves exit only when both sides share one provenanced format; raw renderings stay unknown.
export function processStartTimesDiffer(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return false;
  const format = psStartTimeFormat(left);
  if (format !== psStartTimeFormat(right) || format === 'unqualified') return false;
  return left !== right;
}

/**
 * Canonicalize a pinned C-form lstart to a zone-independent token. The probe pins `TZ=UTC`, so the
 * wall-clock fields are UTC and are parsed with `Date.UTC` — never the reader's local zone, which
 * could differ from the zone the ps child inherited and which folds ambiguous times at DST.
 */
function canonicalPosixBirthToken(lstart: string): string | null {
  const match = PS_START_TIME_FIELDS.exec(lstart.trim());
  const month = match === null ? -1 : PS_MONTHS.indexOf(match[2]!);
  if (match === null || month < 0) return null;
  const startedAtMs = Date.UTC(
    Number(match[7]),
    month,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
  return Number.isFinite(startedAtMs) ? `${POSIX_BIRTH_TOKEN_PREFIX}${startedAtMs}` : null;
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

/** One blocking process-tool snapshot; unanswered pids are unknown, never absence. Use the async variant from waiting paths. */
export function readHostProcessIdentityObservations(
  pids: Iterable<number>,
): ReadonlyMap<number, HostProcessIdentityObservation> {
  const selected = uniquePositivePids(pids);
  if (selected.length === 0) return new Map();
  return readHostProcessIdentitySnapshot(selected, readHostProcessIdentityRowsSync(selected));
}

/** {@link readHostProcessIdentityObservations} off the event loop: same snapshot, same fail-closed answer. */
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
    const result = runCmdSync(
      hostPsCommand(),
      HOST_PROCESS_IDENTITY_PS_ARGS(pids),
      psLstartReadOptions(PS_TIMEOUT_MS),
    );
    return result.exitCode !== 0 ? [] : parseHostProcessIdentityRows(result.stdout);
  } catch {
    // A failed ps snapshot is unknown evidence; callers remain fail-closed.
    return [];
  }
}

async function readHostProcessIdentityRowsAsync(
  pids: readonly number[],
): Promise<readonly HostProcessIdentityRow[]> {
  if (isWindowsHostPlatform()) {
    return windowsProcessIdentityRows(
      await readWindowsProcessRowsAsync(pids, WINDOWS_PS_TIMEOUT_MS),
    );
  }
  return await runHostPsAsync(
    HOST_PROCESS_IDENTITY_PS_ARGS(pids),
    psLstartReadOptions(PS_TIMEOUT_MS),
    parseHostProcessIdentityRows,
  );
}

function parseHostProcessIdentityRows(stdout: string): HostProcessIdentityRow[] {
  const rows: HostProcessIdentityRow[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1]!, 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    // On Linux both facts come from one /proc read; the ps row is the fallback when /proc is unreadable.
    const linux = readLinuxProcessStat(pid);
    // A ps lstart row canonicalizes to a zone-independent posix: token; an unparseable raw value
    // stays unqualified and is later treated as unverified evidence.
    const startTime = linux ? linux.startTime : (canonicalPosixBirthToken(match[3]!) ?? match[3]!);
    rows.push(linux ? { pid, ...linux } : { pid, state: match[2]!, startTime });
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
  if (field === 'lstart=') {
    const token = readLinuxProcessStat(pid)?.startTime;
    if (token !== undefined) return token;
  }
  try {
    const result = runCmdSync(
      hostPsCommand(),
      ['-p', String(pid), '-o', field],
      // Only the lstart-bearing read is locale-pinned; command/state keep the caller's locale.
      field === 'lstart=' ? psLstartReadOptions(PS_TIMEOUT_MS) : psReadOptions(PS_TIMEOUT_MS),
    );
    const value = processFieldValue(result);
    return field === 'lstart=' ? (canonicalPosixBirthToken(value ?? '') ?? value) : value;
  } catch {
    return null;
  }
}

function processFieldValue(result: ExecResult): string | null {
  if (result.exitCode !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

/** Walks process-table stdout, keeping rows whose first groups are a positive pid (and optional ppid). */
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

/* Windows branch (#3291): no `ps`; one CIM query gives CreationDate (PID-reuse proof) and
   CommandLine (daemon-identity match), and a terminated process leaves the table, so no live
   row is a zombie. A failed query is unknown evidence, exactly like a failed `ps`. */

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
    options.runCommand ? 'ps' : hostPsCommand(),
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

/** The signal a stop opens with, before it escalates to SIGKILL. */
export type GracefulStopSignal = 'SIGTERM' | 'SIGINT';

type StopSignal = GracefulStopSignal | 'SIGKILL';

/**
 * The outcome of a stop a caller may act on; a tracked process may be forgotten only on `stopped`.
 * - `stopped`: pid released or proven reassigned; `signal` is the last one sent, if any.
 * - `retained` + `signal-failed` / `exit-timeout` / `identity-unverified`: the pid stayed; the
 *   reason says why nothing may be forgotten or signaled further.
 */
export type ConfirmedProcessStop =
  | Readonly<{ status: 'stopped'; signal?: StopSignal; reassigned?: true }>
  | Readonly<{ status: 'retained'; reason: 'signal-failed'; signal: StopSignal; errno: string }>
  | Readonly<{ status: 'retained'; reason: 'exit-timeout'; signal: 'SIGKILL' }>
  | Readonly<{ status: 'retained'; reason: 'identity-unverified' }>;

/** The verdict keys a retained stop publishes as error `details`, and nothing else. */
export type ConfirmedProcessStopDetails = Readonly<{
  reason: Extract<ConfirmedProcessStop, { status: 'retained' }>['reason'];
  signal?: StopSignal;
  errno?: string;
  pid: number;
}>;

/** Projects a retained verdict onto the publishable `details` keys, and nothing else. */
export function confirmedProcessStopDetails(
  retained: Extract<ConfirmedProcessStop, { status: 'retained' }>,
  pid: number,
): ConfirmedProcessStopDetails {
  return {
    reason: retained.reason,
    signal: 'signal' in retained ? retained.signal : undefined,
    errno: retained.reason === 'signal-failed' ? retained.errno : undefined,
    pid,
  };
}

/** Names a pid the stop left alone; it must never read as "still running". */
export function describeUnconfirmedProcessStop(pid: number, claimedAs: string): string {
  return `pid ${pid} could not be confirmed as ${claimedAs}, so no signal was sent to it`;
}

/** Which verdict a retained stop recorded, as it travels through untyped error `details`. */
type ConfirmedProcessStopReason = Extract<ConfirmedProcessStop, { status: 'retained' }>['reason'];

/**
 * Whether `reason` names a retained stop verdict. Forwarding gates on this rather than on error text,
 * so an unrelated failure's details cannot be forwarded as one.
 */
function isConfirmedProcessStopReason(value: unknown): value is ConfirmedProcessStopReason {
  return value === 'signal-failed' || value === 'exit-timeout' || value === 'identity-unverified';
}

/**
 * The verdict a nested layer published, or nothing when the error carries no stop verdict. A wrapper
 * that flattens the inner message keeps the verdict in `details` and drops the inner surface's file
 * paths and advice, which describe a file the caller of the wrapper was not asked about.
 */
export function readConfirmedProcessStopDetails(
  details: Record<string, unknown> | undefined,
): ConfirmedProcessStopDetails | undefined {
  const reason = details?.reason;
  const pid = details?.pid;
  if (!isConfirmedProcessStopReason(reason) || typeof pid !== 'number') return undefined;
  const signal = details?.signal;
  const errno = details?.errno;
  return {
    reason,
    signal:
      signal === 'SIGTERM' || signal === 'SIGINT' || signal === 'SIGKILL' ? signal : undefined,
    errno: reason === 'signal-failed' && typeof errno === 'string' ? errno : undefined,
    pid,
  };
}

/** The pid to stop and the caller's recorded claims; a stop signals only a process it can name. */
export type ProcessStopTarget = Readonly<{
  pid: number;
  identity: ProcessStopIdentity;
}>;

export type ProcessStopIdentity = Readonly<{
  /** The start time recorded for this pid; a differing one proves the pid changed hands. */
  startTime?: string;
  /** Whether `command` names the process this stop is meant for. */
  matches?: (command: string) => boolean;
}>;

/**
 * How long each signal stage may wait for the exit. `termTimeoutMs` is the grace the opening
 * signal gets, SIGTERM unless `gracefulSignal` names SIGINT for a process that finalizes its output
 * on an interrupt; `killTimeoutMs` is how long SIGKILL may take to be confirmed.
 */
export type ProcessStopBudget = Readonly<{
  termTimeoutMs: number;
  killTimeoutMs: number;
  gracefulSignal?: GracefulStopSignal;
}>;

/**
 * The one identity rule before a signal: `exited` (zombie), `reassigned` (a readable fact
 * contradicts the record), `ours` (every recorded claim read and matching), or `unverified`
 * (everything else — never proof of exit, never permission to signal).
 */
export type ProcessIdentityVerdict = 'ours' | 'exited' | 'reassigned' | 'unverified';

export function judgeProcessIdentity(
  expected: ProcessStopIdentity,
  facts: HostProcessIdentityFacts,
): ProcessIdentityVerdict {
  if (facts.zombie) return 'exited';
  const { startTime, matches } = expected;
  if (processStartTimesDiffer(startTime, facts.startTime)) return 'reassigned';
  const commandMatches = facts.command === null || !matches ? undefined : matches(facts.command);
  if (!startTime && commandMatches === false) return 'reassigned';
  if (!startTime && !matches) return 'unverified';
  const startTimeConfirmed = !startTime || facts.startTime === startTime;
  const commandConfirmed = !matches || commandMatches === true;
  return startTimeConfirmed && commandConfirmed ? 'ours' : 'unverified';
}

/**
 * The one TERM-then-KILL escalation: every signal needs a host-confirmed identity
 * ({@link judgeProcessIdentity}); unreadable identity retains rather than signaling.
 */
export async function stopProcessAndConfirmExit(
  target: ProcessStopTarget,
  budget: ProcessStopBudget,
): Promise<ConfirmedProcessStop> {
  // Stale or malformed process state must never aim a signal at the caller itself.
  if (target.pid === process.pid) throw new RangeError('Cannot stop the current process');
  const identity = await proveStopTargetIdentity(target);
  if (identity === 'released' || identity === 'exited') return { status: 'stopped' };
  if (identity === 'reassigned') return { status: 'stopped', reassigned: true };
  if (identity === 'unverified') return { status: 'retained', reason: 'identity-unverified' };
  const graceful = budget.gracefulSignal ?? 'SIGTERM';
  const term = await proveSignalStage(target, graceful, budget.termTimeoutMs);
  if (term.proof !== 'survived') return stageVerdict(term, graceful);
  const kill = await proveSignalStage(target, 'SIGKILL', budget.killTimeoutMs);
  if (kill.proof !== 'survived' && kill.proof !== 'unverified')
    return stageVerdict(kill, 'SIGKILL');
  return { status: 'retained', reason: 'exit-timeout', signal: 'SIGKILL' };
}

/** The verdict a signal stage settles on its own, before any further signal. */
function stageVerdict(
  stage: Exclude<SignalStageProof, { proof: 'survived' }>,
  signal: StopSignal,
): ConfirmedProcessStop {
  if (stage.proof === 'exited') return { status: 'stopped', signal };
  if (stage.proof === 'reassigned') return { status: 'stopped', signal, reassigned: true };
  // A refused graceful signal is the whole verdict: the host refuses SIGKILL by the same
  // permission check, so escalating would spend a second budget repeating it.
  if (stage.proof === 'refused') return retainedSignalFailure(signal, stage.errno);
  // The pid outlived the grace period and the host will not say what it is now.
  return { status: 'retained', reason: 'identity-unverified' };
}

/** Pre-signal identity proof: `released` when `kill(pid, 0)` fails, else {@link judgeProcessIdentity}. */
async function proveStopTargetIdentity(
  target: ProcessStopTarget,
): Promise<ProcessIdentityVerdict | 'released'> {
  if (!isStopPidLive(target.pid)) return 'released';
  return judgeProcessIdentity(target.identity, await readProcessIdentityFacts(target.pid));
}

function retainedSignalFailure(signal: StopSignal, errno: string): ConfirmedProcessStop {
  return { status: 'retained', reason: 'signal-failed', signal, errno };
}

/** What one signal stage proved, within the budget that stage was given. */
type SignalStageProof =
  | Readonly<{ proof: 'exited' | 'reassigned' | 'unverified' | 'survived' }>
  | Readonly<{ proof: 'refused'; errno: string }>;

/**
 * Sends one signal and waits its budget. A pid that outlives the budget is judged again, which is
 * also the identity proof the next signal needs: `kill(pid, 0)` cannot tell, because `EPERM` also
 * comes back for a zombie awaiting its parent, and on Windows for a process that exited while its
 * object still had handles.
 */
async function proveSignalStage(
  target: ProcessStopTarget,
  signal: StopSignal,
  timeoutMs: number,
): Promise<SignalStageProof> {
  const errno = signalProcessForStop(target.pid, signal);
  // `ESRCH` is absence; any other refusal still leaves a live pid worth waiting on, because the
  // owner may release it inside this budget, and a released pid is what the caller may forget.
  if (errno === 'ESRCH') return { proof: 'exited' };
  if (await waitForStopPidRelease(target.pid, timeoutMs)) return { proof: 'exited' };
  const verdict = await proveStopTargetIdentity(target);
  if (verdict === 'released' || verdict === 'exited') return { proof: 'exited' };
  if (verdict === 'reassigned') return { proof: 'reassigned' };
  if (errno !== undefined) return { proof: 'refused', errno };
  return { proof: verdict === 'unverified' ? 'unverified' : 'survived' };
}

const STOP_LIVENESS_POLL_MS = 50;

/**
 * Whether `kill(pid, 0)` finds the process. `isProcessAlive` reads every answer but `EPERM` as
 * absence, which suits a best-effort sweep and not a stop: here only `ESRCH` releases a pid, and an
 * answer that is not about the process at all must not become permission to forget it.
 */
function isStopPidLive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

async function waitForStopPidRelease(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isStopPidLive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(STOP_LIVENESS_POLL_MS, Math.max(0, deadline - Date.now())));
  }
}

/** The errno that refused the signal, or `undefined` when the host accepted it. */
function signalProcessForStop(pid: number, signal: StopSignal): string | undefined {
  // A non-positive pid is no process at all: `kill(0, …)` would address our own process group.
  if (!Number.isInteger(pid) || pid <= 0) return 'ESRCH';
  try {
    process.kill(pid, signal);
    return undefined;
  } catch (error) {
    // Only an errno classifies a stop outcome: Node's argument faults carry a `code` too, and one
    // reported as a refusal would invent a process for the caller to go and stop.
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === 'string' && ERRNO_CODE.test(code)) return code;
    throw error;
  }
}

const ERRNO_CODE = /^E[A-Z0-9]+$/;

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
