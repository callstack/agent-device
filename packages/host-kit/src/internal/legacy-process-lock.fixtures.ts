import fs from 'node:fs';

// Guard acquisition from c237027737bf4737e324adae2146ba63891152a3, before protocol hardening.
export function holdLegacyReclaimMutex(mutexPath: string, abandonedAfterMs: number): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(mutexPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!clearAbandonedReclaimMutex(mutexPath, abandonedAfterMs)) return false;
    }
  }
  return false;
}

function clearAbandonedReclaimMutex(mutexPath: string, abandonedAfterMs: number): boolean {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(mutexPath);
  } catch {
    return true;
  }
  if (Date.now() - stats.mtimeMs < abandonedAfterMs) return false;
  try {
    fs.rmdirSync(mutexPath);
  } catch {}
  return true;
}
