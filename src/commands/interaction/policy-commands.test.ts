import { describe, expect, test } from 'vitest';
import type { CliFlags } from '@agent-device/contracts/command';
import {
  actCliReader,
  actCommandMetadata,
  suggestCliReader,
  suggestCommandMetadata,
} from './index.ts';
import { createPolicyProvider } from '../policy/policy-provider.ts';
import { listCliCommandNames } from '@agent-device/command-registry/catalog';
import { commandDescriptors } from '@agent-device/command-registry/registry';
import { listMcpCommandMetadata } from '../command-metadata.ts';
import { POLICY_API_KEY_ENV } from '@agent-device/command-registry/flag-definitions-workflow';

describe('policy command interface', () => {
  test('owns suggest and act public metadata', () => {
    expect(suggestCommandMetadata.name).toBe('suggest');
    expect(actCommandMetadata.name).toBe('act');
  });

  test('reads a goal positional and the policy flag', () => {
    expect(suggestCliReader(['sign in'], { policy: 'jev' } as CliFlags)).toMatchObject({
      goal: 'sign in',
      policy: 'jev',
    });
  });

  test('reads the loop budget, confidence floor, and input map', () => {
    expect(
      actCliReader(['sign in'], {
        batchMaxSteps: 8,
        minConfidence: 0.6,
        policyInput: ['phone=5555550100'],
      } as unknown as CliFlags),
    ).toMatchObject({
      goal: 'sign in',
      maxSteps: 8,
      minConfidence: 0.6,
      inputs: ['phone=5555550100'],
    });
  });

  test('refuses an empty goal', () => {
    for (const read of [suggestCliReader, actCliReader]) {
      expect(() => read(['   '], {} as CliFlags)).toThrow(
        expect.objectContaining({
          code: 'INVALID_ARGS',
          message: expect.stringContaining('needs a goal'),
        }),
      );
    }
  });
});

describe('policy provider resolution', () => {
  test('refuses to run without a key, naming the environment entry and the fallback', () => {
    expect(() => createPolicyProvider('jev', {})).toThrow(
      expect.objectContaining({
        code: 'INVALID_ARGS',
        message: expect.stringContaining('TYPESAFE_API_KEY is not set'),
      }),
    );
  });

  test('refuses an unknown provider name', () => {
    expect(() => createPolicyProvider('oracle', { TYPESAFE_API_KEY: 'k' })).toThrow(
      expect.objectContaining({ message: expect.stringContaining('Unknown policy provider') }),
    );
  });

  test('builds the jev provider when the key is present', () => {
    expect(createPolicyProvider('jev', { TYPESAFE_API_KEY: 'k' }).name).toBe('jev');
  });
});

/**
 * The surface is identical with and without a credential: the commands are always listed and
 * always offered over MCP, and refuse at run time. Nothing here reads the environment, so the
 * assertions run the projections twice with the key set and unset and compare.
 */
describe('the command surface does not depend on the key', () => {
  const POLICY_COMMANDS = ['suggest', 'act'] as const;

  function withKey<T>(value: string | undefined, read: () => T): T {
    const previous = process.env[POLICY_API_KEY_ENV];
    if (value === undefined) delete process.env[POLICY_API_KEY_ENV];
    else process.env[POLICY_API_KEY_ENV] = value;
    try {
      return read();
    } finally {
      if (previous === undefined) delete process.env[POLICY_API_KEY_ENV];
      else process.env[POLICY_API_KEY_ENV] = previous;
    }
  }

  test('both commands are in the CLI catalog whether or not the key is set', () => {
    const withoutKey = withKey(undefined, listCliCommandNames);
    const withKeySet = withKey('a-key', listCliCommandNames);
    expect(withoutKey).toEqual(withKeySet);
    for (const command of POLICY_COMMANDS) expect(withoutKey).toContain(command);
  });

  test('both commands are offered over MCP whether or not the key is set', () => {
    const toolNames = () => listMcpCommandMetadata().map((tool) => tool.name);
    expect(withKey(undefined, toolNames)).toEqual(withKey('a-key', toolNames));
    for (const command of POLICY_COMMANDS) {
      expect(withKey(undefined, toolNames)).toContain(command);
    }
  });

  test('each MCP tool takes a goal and never takes the credential', () => {
    for (const command of POLICY_COMMANDS) {
      const tool = withKey(undefined, () =>
        listMcpCommandMetadata().find((entry) => entry.name === command),
      );
      const schema = tool?.inputSchema;
      expect(Object.keys(schema?.properties ?? {}), `${command} must accept a goal`).toContain(
        'goal',
      );
      // The credential is environment-only: the description may name the variable so a model
      // knows what to set, but no input may ever carry its value.
      expect(JSON.stringify(schema)).not.toContain(POLICY_API_KEY_ENV);
      expect(JSON.stringify(schema).toLowerCase()).not.toContain('apikey');
      expect(tool?.description).toContain(POLICY_API_KEY_ENV);
    }
  });

  test('neither command owns a daemon route', () => {
    for (const command of POLICY_COMMANDS) {
      const descriptor = commandDescriptors.find((entry) => entry.name === command);
      expect(descriptor, `${command} is missing from the registry`).toBeDefined();
      expect(descriptor).not.toHaveProperty('daemon');
    }
  });

  test('no other command gained a policy field', () => {
    const others = commandDescriptors.filter(
      (descriptor) => !(POLICY_COMMANDS as readonly string[]).includes(descriptor.name),
    );
    for (const descriptor of others) {
      expect(JSON.stringify(descriptor), `${descriptor.name} changed`).not.toContain('policy');
    }
  });
});
