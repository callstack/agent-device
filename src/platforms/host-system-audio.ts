import type { ExecBackgroundResult } from '../utils/exec.ts';
import { startMacOsAudioProbeProcess } from './ios/macos-helper.ts';

export type HostSystemAudioProbeProcessOptions = {
  durationMs: number;
  bucketMs: number;
  statusPath: string;
};

export async function startHostSystemAudioProbeProcess(
  options: HostSystemAudioProbeProcessOptions,
): Promise<ExecBackgroundResult> {
  return await startMacOsAudioProbeProcess(options);
}
