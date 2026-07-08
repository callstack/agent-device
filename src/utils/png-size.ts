import { promises as fs } from 'node:fs';
import { AppError } from '../kernel/errors.ts';

export async function readPngSize(filePath: string): Promise<{ width: number; height: number }> {
  const buffer = await fs.readFile(filePath);
  if (buffer.length < 24 || buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new AppError('COMMAND_FAILED', 'Screenshot file is not a valid PNG');
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}
