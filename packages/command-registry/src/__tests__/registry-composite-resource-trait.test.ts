import assert from 'node:assert/strict';
import { test } from 'vitest';
import { commandDescriptors, resolveCommandRecordsSessionAction } from '../registry.ts';

test('every batchable or replay-recorded command declares a resource trait', () => {
  const resourceTraitFor = (command: string) => {
    const descriptor = commandDescriptors.find(({ name }) => name === command);
    return descriptor && 'compositeResource' in descriptor
      ? descriptor.compositeResource
      : undefined;
  };
  for (const descriptor of commandDescriptors) {
    if (!descriptor.batchable && !descriptor.recordsSessionAction) continue;
    assert.ok(resourceTraitFor(descriptor.name), descriptor.name);
  }
  assert.equal(resolveCommandRecordsSessionAction('viewport'), true);
  assert.equal(resourceTraitFor('viewport'), 'none');
});

test('standalone command projection names the public CLI route and preserves input obligations', () => {
  const projectionFor = (command: string) =>
    commandDescriptors.find(({ name }) => name === command)?.standaloneCommandProjection;
  assert.deepEqual(projectionFor('install_source'), {
    command: 'install-from-source',
    arguments: 'original-required',
    session: 'same-session',
  });
  assert.deepEqual(projectionFor('record'), {
    command: 'record',
    arguments: 'original-required',
    session: 'same-session',
  });
  assert.equal(projectionFor('not-a-command'), undefined);
});
