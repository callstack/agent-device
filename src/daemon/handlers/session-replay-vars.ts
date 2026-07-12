import path from 'node:path';
import type { DaemonRequest } from '../types.ts';
import type { ReplayScriptMetadata } from '../../replay/script.ts';

export function buildReplayBuiltinVars(params: {
  req: DaemonRequest;
  sessionName: string;
  metadata: ReplayScriptMetadata;
  resolvedPath: string;
}): Record<string, string> {
  const { req, sessionName, metadata, resolvedPath } = params;
  const flags = req.flags ?? {};
  const cwd = req.meta?.cwd ?? process.cwd();
  const filename = path.relative(cwd, resolvedPath) || resolvedPath;
  const builtins: Record<string, string> = {
    AD_SESSION: sessionName,
    AD_FILENAME: filename,
  };
  const platform = (flags.platform as string | undefined) ?? metadata.platform;
  if (platform) builtins.AD_PLATFORM = platform;
  const target = (flags.target as string | undefined) ?? metadata.target;
  if (target) builtins.AD_TARGET = target;
  const device = flags.device;
  if (typeof device === 'string' && device.length > 0) builtins.AD_DEVICE = device;
  const deviceId = typeof flags.serial === 'string' ? flags.serial : flags.udid;
  if (typeof deviceId === 'string' && deviceId.length > 0) {
    builtins.AD_DEVICE_ID = deviceId;
  }
  if (typeof flags.shardIndex === 'number') {
    builtins.AD_SHARD_INDEX = String(flags.shardIndex);
  }
  if (typeof flags.shardCount === 'number') builtins.AD_SHARD_COUNT = String(flags.shardCount);
  const artifactsDir = flags.artifactsDir;
  if (typeof artifactsDir === 'string' && artifactsDir.length > 0) {
    builtins.AD_ARTIFACTS = artifactsDir;
  }
  return builtins;
}
