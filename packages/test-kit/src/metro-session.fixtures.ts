import fs from 'node:fs';
import path from 'node:path';
import { safeSessionName } from '@agent-device/host-kit/session-paths';

type MetroSessionFixture = { stateDir: string; session: string };

function bindingPath(scope: MetroSessionFixture): string {
  return path.join(scope.stateDir, 'metro-sessions', `${safeSessionName(scope.session)}.json`);
}

export function writeMetroSessionFixture(
  options: MetroSessionFixture & { hints: { controlBaseUrl: string; deviceBaseUrls?: string[] } },
): void {
  const file = bindingPath(options);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(options.hints));
}

export function readMetroSessionFixture(scope: MetroSessionFixture): unknown {
  const file = bindingPath(scope);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
}
