import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { commandAcceptsReadinessBudget } from '@agent-device/command-registry/registry';
import { findCommandMetadata, listCommandMetadata } from './command-metadata.ts';

const SELECTOR_TARGET = { kind: 'selector', selector: 'label=Continue' };

function metadataFor(name: string) {
  const metadata = findCommandMetadata(name);
  assert.ok(metadata, `expected command metadata for ${name}`);
  return metadata;
}

test('a command advertises readinessTimeoutMs exactly when its descriptor declares the budget', () => {
  for (const metadata of listCommandMetadata()) {
    const properties = metadata.inputSchema.properties ?? {};
    assert.equal(
      'readinessTimeoutMs' in properties,
      commandAcceptsReadinessBudget(metadata.name),
      metadata.name,
    );
  }
});

test('press reads readinessTimeoutMs', () => {
  const input = metadataFor('press').readInput({
    target: SELECTOR_TARGET,
    readinessTimeoutMs: 2_000,
  }) as { readinessTimeoutMs?: number };
  assert.equal(input.readinessTimeoutMs, 2_000);
});

test('fill refuses readinessTimeoutMs with an input error, and reads without it', () => {
  const fill = metadataFor('fill');
  assert.doesNotThrow(() => fill.readInput({ target: SELECTOR_TARGET, text: 'hi' }));
  assert.throws(
    () => fill.readInput({ target: SELECTOR_TARGET, text: 'hi', readinessTimeoutMs: 2_000 }),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_ARGS',
  );
});
