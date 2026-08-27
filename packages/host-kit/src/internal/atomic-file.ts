import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { emitDiagnostic } from './diagnostics.ts';

export type AtomicPublishMode = 'replace' | 'link-exclusive';

/**
 * Publishes a complete file from a same-directory temporary sibling.
 *
 * The temporary file is always removed after the publish attempt. Cleanup is
 * best effort and never replaces the write or publish error; when a request
 * diagnostics scope exists, a cleanup failure is retained as secondary evidence.
 */
export function publishFileSync(options: {
  destination: string;
  contents: string;
  mode?: number;
  publish?: AtomicPublishMode;
}): void {
  withAtomicPublishTempPathSync(options.destination, (temporaryPath) => {
    if (options.mode === undefined) {
      fs.writeFileSync(temporaryPath, options.contents, 'utf8');
    } else {
      fs.writeFileSync(temporaryPath, options.contents, {
        encoding: 'utf8',
        mode: options.mode,
      });
    }
    if (options.publish === 'link-exclusive') {
      fs.linkSync(temporaryPath, options.destination);
    } else {
      fs.renameSync(temporaryPath, options.destination);
    }
  });
}

/**
 * Gives a specialized durable publisher a canonical temp path and cleanup
 * ownership while it performs its own open/fsync/safety protocol.
 */
export function withAtomicPublishTempPathSync<T>(
  destination: string,
  publish: (temporaryPath: string) => T,
): T {
  const temporaryPath = createAtomicPublishTempPath(destination);
  try {
    return publish(temporaryPath);
  } finally {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch (error) {
      emitDiagnostic({
        level: 'warn',
        phase: 'atomic_file_cleanup_failed',
        data: {
          destination,
          temporaryPath,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}

/** Returns the canonical same-directory temp path used by atomic publishers. */
function createAtomicPublishTempPath(destination: string): string {
  return path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}-${crypto.randomUUID()}.tmp`,
  );
}

/** Identifies a temp path produced for a particular destination. */
export function isAtomicPublishTemporaryPath(value: unknown, destination: string): boolean {
  if (typeof value !== 'string') return false;
  if (path.dirname(value) !== path.dirname(destination)) return false;
  const name = path.basename(value);
  return name.startsWith(`.${path.basename(destination)}.`) && name.endsWith('.tmp');
}
