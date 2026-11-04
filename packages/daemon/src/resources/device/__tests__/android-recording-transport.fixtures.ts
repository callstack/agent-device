import path from 'node:path';

/** Model the transport's generation-scoped marker address for a native artifact. */
export function androidRecordingMarkerPath(remotePath: string): string {
  const name = path.posix.basename(remotePath);
  const match = /^agent-device-recording-v2-([a-f0-9]{64})-\d{1,20}\.mp4$/.exec(name);
  if (!match || path.posix.dirname(remotePath) !== '/sdcard')
    throw new Error('Invalid Android recording artifact path');
  return `/sdcard/agent-device-recording-v2-${match[1]}.json`;
}
