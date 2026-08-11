import fs from 'node:fs';
import { likelyPlayableMp4Container } from './harness.ts';
import {
  manifestPath,
  parseManifestWrite,
  type AndroidRecordingManifestFixture,
} from './android-recording-manifest-fixtures.ts';
import type { AndroidAdbProvider } from '../../../src/platforms/android/adb-executor.ts';

export type PullCall = { remotePath: string; localPath: string };

type NativeProcess = { remotePath: string; startTime: string; alive: boolean };
type ProviderState = {
  manifests: Map<string, AndroidRecordingManifestFixture>;
  processes: Map<string, NativeProcess>;
  pulls: number;
};

export function createAndroidRecordingProvider(params: {
  manifests?: readonly AndroidRecordingManifestFixture[];
  calls: string[][];
  pulls?: PullCall[];
  onPull?: (remotePath: string, localPath: string, count: number) => void;
  deadPids?: readonly string[];
}): AndroidAdbProvider {
  const state = createProviderState(params.manifests, params.deadPids);
  return {
    exec: async (args) => respondToCommand(args, params, state),
  };
}

function createProviderState(
  initialManifests: readonly AndroidRecordingManifestFixture[] = [],
  deadPids: readonly string[] = [],
): ProviderState {
  const state: ProviderState = { manifests: new Map(), processes: new Map(), pulls: 0 };
  for (const manifest of initialManifests) {
    state.manifests.set(manifestPath(manifest), manifest);
    addManifestProcesses(manifest, state.processes, deadPids);
  }
  return state;
}

function respondToCommand(
  args: readonly string[],
  params: Parameters<typeof createAndroidRecordingProvider>[0],
  state: ProviderState,
) {
  params.calls.push([...args]);
  const pull = respondToPull(args, params, state);
  if (pull) return pull;
  if (args.join(' ') === 'shell getprop sys.boot_completed') return ok('1\n');
  const response = args[0] === 'shell' ? respondToShellCommand(args[1] ?? '', state) : undefined;
  if (response) return response;
  throw new Error(`Unhandled Android recording provider command: ${args.join(' ')}`);
}

function respondToPull(
  args: readonly string[],
  params: Parameters<typeof createAndroidRecordingProvider>[0],
  state: ProviderState,
) {
  const [operation, remotePath, localPath] = args;
  if (operation !== 'pull' || !remotePath || !localPath) return undefined;
  state.pulls += 1;
  params.pulls?.push({ remotePath, localPath });
  if (params.onPull) params.onPull(remotePath, localPath, state.pulls);
  else fs.writeFileSync(localPath, likelyPlayableMp4Container());
  return ok();
}

function respondToShellCommand(command: string, state: ProviderState) {
  return (
    respondToManifestCommand(command, state) ??
    respondToProcessCommand(command, state.processes) ??
    respondToScreenrecordCommand(command, state.processes) ??
    respondToArtifactCommand(command)
  );
}

function respondToManifestCommand(command: string, state: ProviderState) {
  const target = findManifestTarget(command);
  if (target) return respondToManifestTarget(command, target, state.manifests);
  const written = command.startsWith('printf %s ') ? parseManifestWrite(command) : undefined;
  if (!written) return undefined;
  state.manifests.set(written.path, written.manifest);
  addManifestProcesses(written.manifest, state.processes);
  return ok();
}

function findManifestTarget(command: string): string | undefined {
  for (const prefix of ['test -e ', 'cat ', 'rm -f ']) {
    const target = shellPath(command, prefix);
    if (target?.endsWith('/agent-device-recording-active.json')) return target;
  }
  return undefined;
}

function respondToManifestTarget(
  command: string,
  target: string,
  manifests: Map<string, AndroidRecordingManifestFixture>,
) {
  if (command.startsWith('test -e ')) return manifests.has(target) ? ok() : missing();
  if (command.startsWith('cat '))
    return manifests.has(target) ? ok(JSON.stringify(manifests.get(target))) : missing();
  manifests.delete(target);
  return ok();
}

function respondToProcessCommand(command: string, processes: Map<string, NativeProcess>) {
  return (
    respondToProcessList(command, processes) ??
    respondToProcessDirectory(command, processes) ??
    respondToProcessMetadata(command, processes) ??
    respondToProcessSignal(command, processes)
  );
}

function respondToProcessList(command: string, processes: Map<string, NativeProcess>) {
  if (command !== 'ps -A -o pid=') return undefined;
  const alivePids = [...processes.entries()]
    .filter(([, nativeProcess]) => nativeProcess.alive)
    .map(([pid]) => pid);
  return ok(alivePids.length > 0 ? `${alivePids.join('\n')}\n` : '');
}

function respondToProcessDirectory(command: string, processes: Map<string, NativeProcess>) {
  const directory = /^test -d \/proc\/(\d+)$/.exec(command);
  const [, directoryPid] = directory ?? [];
  if (directoryPid) return processes.get(directoryPid)?.alive ? ok() : missing();
  return undefined;
}

function respondToProcessMetadata(command: string, processes: Map<string, NativeProcess>) {
  const proc = /^cat \/proc\/(\d+)\/(stat|cmdline)$/.exec(command);
  const [, pid, field] = proc ?? [];
  if (pid && (field === 'stat' || field === 'cmdline')) return processResult(processes, pid, field);
  return undefined;
}

function respondToProcessSignal(command: string, processes: Map<string, NativeProcess>) {
  const kill = /^kill -(?:2|9) (\d+)$/.exec(command);
  const [, killPid] = kill ?? [];
  if (!killPid) return undefined;
  const nativeProcess = processes.get(killPid);
  if (nativeProcess) nativeProcess.alive = false;
  return nativeProcess ? ok() : missing();
}

function respondToScreenrecordCommand(command: string, processes: Map<string, NativeProcess>) {
  if (!command.startsWith('screenrecord --bit-rate ')) return undefined;
  const remotePath = command.match(
    /(\/(?:sdcard|data\/local\/tmp)\/agent-device-recording-\d+\.mp4)/,
  )?.[1];
  if (!remotePath) return missing();
  processes.set('4321', { remotePath, startTime: '101', alive: true });
  return ok('4321\n');
}

function respondToArtifactCommand(command: string) {
  for (const prefix of ['test -e ', 'rm -f ']) {
    const target = shellPath(command, prefix);
    if (target && isRecordingArtifactPath(target)) return ok();
  }
  const target = shellPath(command, 'stat -c %s ');
  return target && isRecordingArtifactPath(target) ? ok('2048\n') : undefined;
}

function isRecordingArtifactPath(path: string): boolean {
  return /^\/(?:sdcard|data\/local\/tmp)\/agent-device-recording-\d+\.mp4$/.test(path);
}

function addManifestProcesses(
  manifest: AndroidRecordingManifestFixture,
  processes: Map<string, NativeProcess>,
  deadPids: readonly string[] = [],
): void {
  for (const chunk of manifest.chunks) {
    processes.set(chunk.remotePid, {
      remotePath: chunk.remotePath,
      startTime: chunk.remoteStartTime,
      alive: !deadPids.includes(chunk.remotePid),
    });
  }
}

function processResult(
  processes: Map<string, NativeProcess>,
  pid: string,
  field: 'stat' | 'cmdline',
) {
  const nativeProcess = processes.get(pid);
  if (!nativeProcess?.alive) return missing();
  return field === 'stat'
    ? ok(
        `${pid} (screenrecord) S ${Array.from({ length: 18 }, () => '0').join(' ')} ${nativeProcess.startTime}`,
      )
    : ok(
        ['/system/bin/screenrecord', '--bit-rate', '8000000', nativeProcess.remotePath, ''].join(
          '\0',
        ),
      );
}

function shellPath(command: string, prefix: string): string | undefined {
  if (!command.startsWith(prefix)) return undefined;
  const value = command.slice(prefix.length).trim();
  return value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1) : value;
}

function ok(stdout = '') {
  return { stdout, stderr: '', exitCode: 0 };
}

function missing() {
  return { stdout: '', stderr: '', exitCode: 1 };
}
