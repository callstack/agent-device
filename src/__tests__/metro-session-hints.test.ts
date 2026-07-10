import { test } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearMetroSessionHints,
  readMetroSessionHints,
  writeMetroSessionHints,
} from '../metro/metro-session-hints.ts';

function tempStateDir(): string {
  const dir = path.join(os.tmpdir(), `agent-device-metro-session-hints-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('readMetroSessionHints returns undefined when no hints were written', () => {
  const stateDir = tempStateDir();
  try {
    assert.equal(readMetroSessionHints({ stateDir, session: 'default' }), undefined);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('writeMetroSessionHints and readMetroSessionHints round-trip per session', () => {
  const stateDir = tempStateDir();
  try {
    writeMetroSessionHints({
      stateDir,
      session: 'proj-a',
      hints: {
        metroHost: '127.0.0.1',
        metroPort: 8082,
        bundleUrl: 'http://127.0.0.1:8082/.expo/.virtual-metro-entry.bundle?platform=ios',
      },
    });
    writeMetroSessionHints({
      stateDir,
      session: 'proj-b',
      hints: { metroHost: '127.0.0.1', metroPort: 8090 },
    });

    assert.deepEqual(readMetroSessionHints({ stateDir, session: 'proj-a' }), {
      metroHost: '127.0.0.1',
      metroPort: 8082,
      bundleUrl: 'http://127.0.0.1:8082/.expo/.virtual-metro-entry.bundle?platform=ios',
    });
    assert.deepEqual(readMetroSessionHints({ stateDir, session: 'proj-b' }), {
      metroHost: '127.0.0.1',
      metroPort: 8090,
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('writeMetroSessionHints overwrites a previous hint for the same session', () => {
  const stateDir = tempStateDir();
  try {
    writeMetroSessionHints({
      stateDir,
      session: 'default',
      hints: { metroHost: '127.0.0.1', metroPort: 8081 },
    });
    writeMetroSessionHints({
      stateDir,
      session: 'default',
      hints: { metroHost: '127.0.0.1', metroPort: 8082 },
    });

    assert.deepEqual(readMetroSessionHints({ stateDir, session: 'default' }), {
      metroHost: '127.0.0.1',
      metroPort: 8082,
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('clearMetroSessionHints removes a stored hint', () => {
  const stateDir = tempStateDir();
  try {
    writeMetroSessionHints({
      stateDir,
      session: 'default',
      hints: { metroHost: '127.0.0.1', metroPort: 8082 },
    });
    clearMetroSessionHints({ stateDir, session: 'default' });

    assert.equal(readMetroSessionHints({ stateDir, session: 'default' }), undefined);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('readMetroSessionHints ignores a corrupt hints file instead of throwing', () => {
  const stateDir = tempStateDir();
  try {
    const filePath = path.join(stateDir, 'metro-sessions', 'default.json');
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, 'not json');

    assert.equal(readMetroSessionHints({ stateDir, session: 'default' }), undefined);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('sessions with unsafe characters get distinct sanitized files', () => {
  const stateDir = tempStateDir();
  try {
    writeMetroSessionHints({
      stateDir,
      session: 'feature/branch-a',
      hints: { metroHost: '127.0.0.1', metroPort: 8082 },
    });

    assert.deepEqual(readMetroSessionHints({ stateDir, session: 'feature/branch-a' }), {
      metroHost: '127.0.0.1',
      metroPort: 8082,
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
