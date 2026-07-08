import { promises as fs } from 'node:fs';
import { AppError } from '../kernel/errors.ts';

export async function readPngSize(filePath: string): Promise<{ width: number; height: number }> {
  const file = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(24);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead < buffer.length || buffer.toString('ascii', 12, 16) !== 'IHDR') {
      throw new AppError('COMMAND_FAILED', 'Screenshot file is not a valid PNG');
    }
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  } finally {
    await file.close();
  }
}
