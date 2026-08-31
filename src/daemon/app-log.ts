import fs from 'node:fs';
import path from 'node:path';
import {
  openVerifiedFileForAppend,
  openVerifiedFileForRead,
  openVerifiedFileForTruncate,
} from '@agent-device/host-kit/file';
import { ensureAppLogPath } from '../utils/app-log-files.ts';

export function getAppLogPathMetadata(outPath: string): {
  exists: boolean;
  sizeBytes: number;
  modifiedAt?: string;
} {
  const descriptor = openVerifiedFileForRead(outPath);
  if (descriptor === undefined) return { exists: false, sizeBytes: 0 };
  try {
    const stats = fs.fstatSync(descriptor);
    return {
      exists: true,
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function appendAppLogMarker(outPath: string, marker: string): void {
  ensureAppLogPath(outPath);
  const line = `[agent-device][mark][${new Date().toISOString()}] ${marker.trim() || 'marker'}\n`;
  const descriptor = openVerifiedFileForAppend(outPath);
  try {
    fs.writeFileSync(descriptor, line, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

export function clearAppLogFiles(outPath: string): {
  path: string;
  cleared: boolean;
  removedRotatedFiles: number;
} {
  const dir = path.dirname(outPath);
  const base = path.basename(outPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const descriptor = openVerifiedFileForTruncate(outPath);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  let removedRotatedFiles = 0;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.startsWith(`${base}.`)) continue;
    const suffix = entry.slice(base.length + 1);
    if (!/^\d+$/.test(suffix)) continue;
    try {
      fs.unlinkSync(path.join(dir, entry));
      removedRotatedFiles += 1;
    } catch {
      // best-effort cleanup
    }
  }
  return { path: outPath, cleared: true, removedRotatedFiles };
}
