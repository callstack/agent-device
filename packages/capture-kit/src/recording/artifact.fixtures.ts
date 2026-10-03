import type { ScreenRecordingRuntimeHost } from '@agent-device/contracts/screen-recording-runtime-host';

/**
 * The recording files a stop moves between host paths, held where the output host would hold them.
 *
 * A copy with no source fails here the way it fails on a real volume, so a stop that names a path it
 * never wrote cannot pass. A backend that produces several files for one recording, or that mirrors the
 * export for its client, copies each of them through this model and is checked the same way.
 */
export function recordingFileStore(initial: Readonly<Record<string, string>> = {}): Readonly<{
  files: Map<string, string>;
  exists(filePath: string): boolean;
  outputs: ScreenRecordingRuntimeHost['outputs'];
}> {
  const files = new Map(Object.entries(initial));
  const missing = (filePath: string) => new Error(`ENOENT: no such file, copyfile '${filePath}'`);
  const copy = (from: string, to: string) => {
    const bytes = files.get(from);
    if (bytes === undefined) throw missing(from);
    files.set(to, bytes);
  };
  return {
    files,
    exists: (filePath) => files.has(filePath),
    outputs: {
      prepare: async (outputPath) => {
        files.delete(outputPath);
      },
      copy: async ({ from, to }) => {
        copy(from, to);
      },
      remove: async (filePath) => {
        files.delete(filePath);
        return files.has(filePath) ? 'present' : 'removed';
      },
    },
  };
}
