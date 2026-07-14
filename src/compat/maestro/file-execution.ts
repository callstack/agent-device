import fs from 'node:fs';
import path from 'node:path';
import type { MaestroCompatibilityTimingPolicy } from './compatibility-policy.ts';
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
  env?: Readonly<Record<string, string>>;
  defaults?: Readonly<Record<string, string | number | boolean>>;
  builtins?: Readonly<Record<string, string>>;
  platform?: MaestroPlatform;
  target?: string;
  startIndex?: number;
  from?: number;
  planDigest?: string;
  timing?: Partial<MaestroCompatibilityTimingPolicy>;
  signal?: AbortSignal;
  observer?: MaestroEngineObserver;
  now?: () => number;
}): Promise<MaestroEngineResult> {
  const filePath = path.resolve(params.filePath);
  const program = parseMaestroProgram(fs.readFileSync(filePath, 'utf8'), { sourcePath: filePath });
  return await executeMaestroProgram(program, params.port, {
    loadProgram: createMaestroProgramLoader(path.dirname(filePath)),
    ...(params.env ? { env: params.env } : {}),
    ...(params.defaults ? { defaults: params.defaults } : {}),
    ...(params.builtins ? { builtins: params.builtins } : {}),
    ...(params.platform ? { platform: params.platform } : {}),
    ...(params.target ? { target: params.target } : {}),
    ...(params.startIndex === undefined ? {} : { startIndex: params.startIndex }),
    ...(params.from === undefined ? {} : { from: params.from }),
    ...(params.planDigest ? { planDigest: params.planDigest } : {}),
    ...(params.timing ? { timing: params.timing } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.observer ? { observer: params.observer } : {}),
    ...(params.now ? { now: params.now } : {}),
  });
}
