import path from 'node:path';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { ReplayScriptMetadata } from '@agent-device/ad-script';

export function buildReplayBuiltinVars(params: {
  req: DaemonWireRequest;
  sessionName: string;
  metadata: ReplayScriptMetadata;
  resolvedPath: string;
  /** The command's host working directory; AD_FILENAME falls back to it when the request omits one. */
  hostCwd: string;
}): Record<string, string> {
  const { req, sessionName, metadata, resolvedPath, hostCwd } = params;
  const flags = req.flags ?? {};
  const builtins: Record<string, string> = {
    AD_SESSION: sessionName,
    AD_FILENAME: resolveReplayFilename(req, resolvedPath, hostCwd),
  };
  addReplayStringBuiltin(builtins, 'AD_PLATFORM', flags.platform ?? metadata.platform);
  addReplayStringBuiltin(builtins, 'AD_TARGET', flags.target ?? metadata.target);
  addReplayStringBuiltin(builtins, 'AD_DEVICE', flags.device);
  addReplayStringBuiltin(builtins, 'AD_DEVICE_ID', resolveReplayDeviceId(flags));
  addReplayNumberBuiltin(builtins, 'AD_SHARD_INDEX', flags.shardIndex);
  addReplayNumberBuiltin(builtins, 'AD_SHARD_COUNT', flags.shardCount);
  addReplayStringBuiltin(builtins, 'AD_ARTIFACTS', flags.artifactsDir);
  return builtins;
}

function resolveReplayFilename(
  req: DaemonWireRequest,
  resolvedPath: string,
  hostCwd: string,
): string {
  const cwd = req.meta?.cwd ?? hostCwd;
  return path.relative(cwd, resolvedPath) || resolvedPath;
}

function resolveReplayDeviceId(flags: NonNullable<DaemonWireRequest['flags']>): unknown {
  return typeof flags.serial === 'string' ? flags.serial : flags.udid;
}

function addReplayStringBuiltin(
  builtins: Record<string, string>,
  key: string,
  value: unknown,
): void {
  if (typeof value === 'string' && value.length > 0) builtins[key] = value;
}

function addReplayNumberBuiltin(
  builtins: Record<string, string>,
  key: string,
  value: unknown,
): void {
  if (typeof value === 'number') builtins[key] = String(value);
}
