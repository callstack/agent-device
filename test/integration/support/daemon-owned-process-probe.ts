// Manual red-proof probe for daemon-owned child processes (#1781 B1, feeds
// #1431). Run by hand against a daemon that has just been stopped; it is what
// produced the #1109 and #1324 evidence in the PR.
//
// It is deliberately NOT wired into a lane. Nothing records what a daemon
// spawned, so ownership has to be reconstructed from the OS, and the three
// real-subprocess daemon lanes run `session list`/`close` with no device,
// simulator, or browser — their daemons own no children, so a lane assertion
// here would only ever compare an empty set to an empty set. The shipped
// oracle (`daemon-leak-oracle.ts`) asserts what the daemon does record: an
// unfinalized capture handle, state-dir residue, and its own survival. Once the
// daemon records owned child pids the way it records captures, this probe
// collapses into "read the record, assert they are dead" and moves back into
// the oracle.
//
// Ownership is explicit and conservative. Global process counts are not
// evidence — the simulator, XCTest, and Chrome-for-Testing own processes this
// daemon does not. A host process is daemon-owned when ANY rule holds:
//
//   descendant     its PPID chain reaches a daemon pid, or any process already
//                  owned below (observable while that ancestor lives; orphans
//                  reparent to launchd/init).
//   process-group  its PGID equals a daemon pid. The CLI launches the daemon
//                  detached (setsid), so the daemon is its own group leader and
//                  every non-detached runCmdBackground child stays in that group
//                  after reparenting. This is the #1324 signature: `simctl io …
//                  recordVideo` with PPID 1 and PGID = the dead daemon's pid.
//                  A pgid is reserved only while the group has a live member, so
//                  on a long-lived host pid reuse can eventually hand the number
//                  to an unrelated process; cross-check the command line.
//   state-dir-env  its environment carries AGENT_DEVICE_STATE_DIR=<state dir>.
//                  The CLI starts the daemon with that variable and children
//                  inherit it, including setsid'd grandchildren the pgid rule
//                  misses (agent-browser's own daemon → Chrome fleet: #1109).
//                  macOS hides the environment of Apple platform binaries
//                  (`ps -E` shows it for node/Chrome, not for /bin/sleep or
//                  simctl), so Apple tooling is caught by the pgid/argv rules.
//   state-dir-argv its command line contains the state dir path as a whole path
//                  token (recorders writing session artifacts, browsers pinned
//                  to a managed home).
//
// Use a fresh state dir per run, so the env/argv rules cannot match a foreign
// process. The probe excludes itself and its own ancestors.
//
// The rules are pinned by `daemon-owned-process-probe.test.ts` against the real
// `ps` rows captured during those proofs, so a regex or ordering edit that stops
// catching either leak fails in CI even though no lane can run this probe.
//
// Usage (prints the report; exits 1 when anything owned is still alive):
//   node --experimental-strip-types test/integration/support/daemon-owned-process-probe.ts \
//     --state-dir <dir> --daemon-pid <pid> [--daemon-pid <pid>…]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCmd } from '../../../src/utils/exec.ts';
import { expandProcessTree, uniquePositivePids } from '../../../src/utils/host-process.ts';

const PS_TIMEOUT_MS = 5_000;
const COMMAND_PREVIEW_CHARS = 160;
// Matches src/utils/host-process.ts: an absolute path so a PATH-resolved
// third-party `ps` (Homebrew, procps) cannot change the flag semantics.
const HOST_PS_COMMAND = process.platform === 'win32' ? 'ps' : '/bin/ps';

export type OwnershipReason = 'descendant' | 'process-group' | 'state-dir-env' | 'state-dir-argv';

export type HostProcess = {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
  /** Environment as a single string; empty when the host hides it. */
  env: string;
};

export type OwnedProcess = HostProcess & { reasons: OwnershipReason[] };

export function findOwnedProcesses(
  processes: readonly HostProcess[],
  daemonPids: readonly number[],
  stateDir: string,
): OwnedProcess[] {
  const excluded = new Set([...ancestorsOf(process.pid, processes), ...daemonPids]);
  const matchers = stateDirMatchers(stateDir);
  const reasonsByPid = new Map<number, OwnershipReason[]>();
  for (const proc of processes) {
    if (excluded.has(proc.pid)) continue;
    const reasons = directOwnershipReasons(proc, daemonPids, matchers);
    if (reasons.length > 0) reasonsByPid.set(proc.pid, reasons);
  }
  // Ownership propagates down the tree: a child of the daemon, or of any process
  // the rules above own, is owned (a detached `(simctl)` grandchild of a leaked
  // recorder shim, DTServiceHub under a runner xcodebuild, …).
  const roots = [...daemonPids, ...reasonsByPid.keys()];
  for (const proc of expandProcessTree(roots, processes)) {
    if (excluded.has(proc.pid) || roots.includes(proc.pid)) continue;
    reasonsByPid.set(proc.pid, [...(reasonsByPid.get(proc.pid) ?? []), 'descendant']);
  }
  return processes.flatMap((proc) => {
    const reasons = reasonsByPid.get(proc.pid);
    return reasons ? [{ ...proc, reasons }] : [];
  });
}

function stateDirMatchers(stateDir: string): { argv: RegExp; env: RegExp } {
  // Whole-path matches only: `<dir>` as a token or `<dir>/…`, never `<dir>-sibling`.
  return {
    argv: new RegExp(`(?:^|[\\s=])${escapeRegExp(stateDir)}(?:[\\s/]|$)`),
    env: new RegExp(`AGENT_DEVICE_STATE_DIR=${escapeRegExp(stateDir)}(?:\\s|$)`),
  };
}

function directOwnershipReasons(
  proc: HostProcess,
  daemonPids: readonly number[],
  matchers: { argv: RegExp; env: RegExp },
): OwnershipReason[] {
  const reasons: OwnershipReason[] = [];
  if (daemonPids.includes(proc.pgid)) reasons.push('process-group');
  if (matchers.env.test(proc.env)) reasons.push('state-dir-env');
  if (matchers.argv.test(proc.command)) reasons.push('state-dir-argv');
  return reasons;
}

function formatReport(owned: readonly OwnedProcess[], stateDir: string, pids: number[]): string {
  const mask = new RegExp(`${escapeRegExp(stateDir)}(?=[\\s/]|$)`, 'g');
  return [
    `daemon-owned processes: ${owned.length > 0 ? 'LEAK' : 'clean'}`,
    `  state dir: ${stateDir}`,
    `  daemon pids: ${pids.join(', ') || '(none)'}`,
    ...owned.map((proc) => {
      const command = proc.command.replace(mask, '<state-dir>');
      return `    pid ${proc.pid} ppid ${proc.ppid} pgid ${proc.pgid} [${proc.reasons.join(',')}] ${
        command.length > COMMAND_PREVIEW_CHARS
          ? `${command.slice(0, COMMAND_PREVIEW_CHARS)}…`
          : command
      }`;
    }),
  ].join('\n');
}

// pid/ppid/pgid plus the command line, and separately the environment so the
// argv and env rules stay distinct. macOS `ps -E` appends the environment to
// the command column for same-user processes; Linux exposes it in /proc.
async function listHostProcesses(): Promise<HostProcess[]> {
  const darwin = process.platform === 'darwin';
  const [tree, darwinEnv] = await Promise.all([
    runPs(['-axww', '-o', 'pid=,ppid=,pgid=,command=']),
    darwin ? runPs(['-E', '-axww', '-o', 'pid=,command=']) : Promise.resolve(''),
  ]);
  const envByPid = new Map(
    parsePsLines(darwinEnv, /^\s*(\d+)\s+(.*)$/).map(([pid, env]) => [Number(pid), env ?? '']),
  );
  return parsePsLines(tree, /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/).map(
    ([pid, ppid, pgid, command]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      command: command ?? '',
      env: darwin ? (envByPid.get(Number(pid)) ?? '') : readLinuxEnviron(Number(pid)),
    }),
  );
}

function parsePsLines(stdout: string, shape: RegExp): string[][] {
  return stdout.split('\n').flatMap((line) => {
    const match = shape.exec(line);
    return match ? [match.slice(1)] : [];
  });
}

async function runPs(args: string[]): Promise<string> {
  const result = await runCmd(HOST_PS_COMMAND, args, {
    allowFailure: true,
    timeoutMs: PS_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw new Error(`ps ${args.join(' ')} failed (${result.exitCode}): ${result.stderr}`);
  }
  return result.stdout;
}

function readLinuxEnviron(pid: number): string {
  try {
    return fs.readFileSync(`/proc/${pid}/environ`, 'latin1').replaceAll('\0', ' ');
  } catch {
    return '';
  }
}

function ancestorsOf(pid: number, processes: readonly HostProcess[]): Set<number> {
  const parentByPid = new Map(processes.map((proc) => [proc.pid, proc.ppid]));
  const chain = new Set<number>();
  let cursor: number | undefined = pid;
  while (cursor && !chain.has(cursor)) {
    chain.add(cursor);
    cursor = parentByPid.get(cursor);
  }
  return chain;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Only when run directly: importing this module (its fixture test) must not
// execute the probe.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const readFlag = (name: string): string[] =>
    args.flatMap((arg, index) => (arg === name && args[index + 1] ? [args[index + 1]!] : []));
  const stateDir = readFlag('--state-dir')[0];
  if (!stateDir) throw new Error('daemon-owned process probe: --state-dir is required');
  const daemonPids = uniquePositivePids(readFlag('--daemon-pid').map(Number));
  const resolvedStateDir = path.resolve(stateDir);
  const owned = findOwnedProcesses(await listHostProcesses(), daemonPids, resolvedStateDir);
  process.stdout.write(`${formatReport(owned, resolvedStateDir, daemonPids)}\n`);
  process.exitCode = owned.length > 0 ? 1 : 0;
}
