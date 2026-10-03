import crypto from 'node:crypto';
import fs from 'node:fs';

/** sha256 of a file's bytes, the same digest a cache manifest records. */
export function digestFile(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
