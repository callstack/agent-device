import { describe, expect, test } from 'vitest';
import { commandDescriptors } from '../registry.ts';

describe('host and command-only platform execution ownership', () => {
  test('daemon and web declare host execution', () => {
    expect(commandDescriptors.find(({ name }) => name === 'daemon')?.platformExecution.kind).toBe(
      'host',
    );
    expect(commandDescriptors.find(({ name }) => name === 'web')?.platformExecution.kind).toBe(
      'host',
    );
  });

  test('replay and test own no platform execution', () => {
    expect(commandDescriptors.find(({ name }) => name === 'replay')?.platformExecution.kind).toBe(
      'none',
    );
    expect(commandDescriptors.find(({ name }) => name === 'test')?.platformExecution.kind).toBe(
      'none',
    );
  });
});
