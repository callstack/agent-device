import fs from 'node:fs';
import path from 'node:path';
import { executeMaestroProgram } from './engine.ts';
import type {
  MaestroEngineObserver,
  MaestroEngineResult,
  MaestroRuntimePort,
} from './engine-types.ts';
import type { MaestroPlatform } from './program-ir.ts';
import { parseMaestroProgram } from './program-ir-parser.ts';
import { createMaestroProgramLoader } from './program-loader.ts';

export async function executeMaestroFile(params: {
  filePath: string;
  port: MaestroRuntimePort;
  env?: Record<string, string>;
  platform?: MaestroPlatform;
  signal?: AbortSignal;
  observer?: MaestroEngineObserver;
}): Promise<MaestroEngineResult> {
  const filePath = path.resolve(params.filePath);
  const program = parseMaestroProgram(fs.readFileSync(filePath, 'utf8'), { sourcePath: filePath });
  return await executeMaestroProgram(program, params.port, {
    loadProgram: createMaestroProgramLoader(path.dirname(filePath)),
    ...(params.env ? { env: params.env } : {}),
    ...(params.platform ? { platform: params.platform } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.observer ? { observer: params.observer } : {}),
  });
}
