import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from './test-utils/tmp-dir.ts';

export function installIsolatedCliTestEnv(
  explicitEnv: Record<string, string | undefined> = {},
): () => void {
  const previousEnv = new Map<string, string | undefined>();
  const explicitKeys = new Set(Object.keys(explicitEnv));
  const tempRoot = mkdtempForTestSync('agent-device-cli-env-');
  const tempHome = path.join(tempRoot, 'home');
  fs.mkdirSync(path.join(tempHome, '.agent-device'), { recursive: true });

  for (const key of Object.keys(process.env)) {
    if (!key.startsWith('AGENT_DEVICE_') || explicitKeys.has(key)) continue;
    previousEnv.set(key, process.env[key]);
    delete process.env[key];
  }

  if (!explicitKeys.has('HOME')) {
    previousEnv.set('HOME', process.env.HOME);
    process.env.HOME = tempHome;
  }

  for (const [key, value] of Object.entries(explicitEnv)) {
    if (!previousEnv.has(key)) {
      previousEnv.set(key, process.env[key]);
    }
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return () => {
    for (const [key, value] of previousEnv.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  };
}
