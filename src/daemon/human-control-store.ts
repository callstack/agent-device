import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import {
  type HumanControlHold,
  normalizeStoredHumanControlHold,
} from './human-control-contract.ts';

export class HumanControlStore {
  private readonly statePath: string | undefined;

  constructor(statePath: string | undefined) {
    this.statePath = statePath;
  }

  load(): HumanControlHold[] {
    if (!this.statePath || !fs.existsSync(this.statePath)) return [];
    let parsed: { version: 1; holds: HumanControlHold[] };
    try {
      parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as typeof parsed;
    } catch (error) {
      throw new AppError(
        'COMMAND_FAILED',
        'Failed to read persisted human-control state.',
        { path: this.statePath },
        error,
      );
    }
    if (parsed.version !== 1 || !Array.isArray(parsed.holds)) {
      throw new AppError('COMMAND_FAILED', 'Persisted human-control state is invalid.', {
        path: this.statePath,
      });
    }
    return parsed.holds.map((hold) => normalizeStoredHumanControlHold(hold));
  }

  persist(holds: Iterable<HumanControlHold>): void {
    if (!this.statePath) return;
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.${String(process.pid)}.tmp`;
    const state = {
      version: 1,
      holds: Array.from(holds, (hold) => cloneHumanControlHold(hold)),
    };
    fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, this.statePath);
    fs.chmodSync(this.statePath, 0o600);
  }
}

export function cloneHumanControlHold(hold: HumanControlHold): HumanControlHold {
  return { ...hold, scope: { ...hold.scope } };
}
