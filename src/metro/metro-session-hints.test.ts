import { test } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

import path from 'node:path';
import {
  clearMetroSessionHints,
  readMetroSessionHints,
  writeMetroSessionHints,
} from './metro-session-hints.ts';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';

function tempStateDir(): string {
  const dir = path.join(
    mkdtempForTestSync('agent-device-metro-session-hints'),
    `agent-device-metro-session-hints-${randomUUID()}`,
  );
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
        controlBaseUrl: 'http://127.0.0.1:8082/',
      },
    });
    writeMetroSessionHints({
      stateDir,
      session: 'proj-b',
      hints: { controlBaseUrl: 'http://127.0.0.1:8090/' },
    });

    assert.deepEqual(readMetroSessionHints({ stateDir, session: 'proj-a' }), {
      controlBaseUrl: 'http://127.0.0.1:8082/',
    });
    assert.deepEqual(readMetroSessionHints({ stateDir, session: 'proj-b' }), {
      controlBaseUrl: 'http://127.0.0.1:8090/',
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
      hints: { controlBaseUrl: 'http://127.0.0.1:8081/' },
    });
    writeMetroSessionHints({
      stateDir,
      session: 'default',
      hints: { controlBaseUrl: 'http://127.0.0.1:8082/' },
    });

    assert.deepEqual(readMetroSessionHints({ stateDir, session: 'default' }), {
      controlBaseUrl: 'http://127.0.0.1:8082/',
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
      hints: { controlBaseUrl: 'http://127.0.0.1:8082/' },
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
      hints: { controlBaseUrl: 'http://127.0.0.1:8082/' },
    });

    assert.deepEqual(readMetroSessionHints({ stateDir, session: 'feature/branch-a' }), {
      controlBaseUrl: 'http://127.0.0.1:8082/',
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('released session records retain their reload address when read as a binding', () => {
  const stateDir = tempStateDir();
  const filePath = path.join(stateDir, 'metro-sessions', 'default.json');
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    JSON.stringify({ bundleUrl: 'https://metro.example.test/tenant-42/index.bundle?platform=ios' }),
  );
  assert.deepEqual(readMetroSessionHints({ stateDir, session: 'default' }), {
    controlBaseUrl: 'https://metro.example.test/tenant-42',
  });
});
