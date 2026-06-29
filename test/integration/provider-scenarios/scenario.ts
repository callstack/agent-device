import assert from 'node:assert/strict';
import type { DaemonRequest } from '../../../src/daemon/types.ts';
import type { ProviderScenarioHarness, ProviderScenarioRpcResult } from './harness.ts';

export type ProviderScenarioState = {
  readonly responses: ReadonlyMap<string, ProviderScenarioRpcResult>;
  response(name: string): ProviderScenarioRpcResult;
};

export type ProviderScenarioDefaults = {
  flags?: DaemonRequest['flags'];
  meta?: DaemonRequest['meta'];
};

export type ProviderScenarioStep = {
  name: string;
  command: string;
  positionals?: string[];
  flags?: DaemonRequest['flags'];
  meta?: DaemonRequest['meta'];
  expectStatus?: number;
  expectData?: Record<string, unknown>;
  assert?: (
    response: ProviderScenarioRpcResult,
    state: ProviderScenarioState,
  ) => void | Promise<void>;
};

export async function runProviderScenario(
  daemon: Pick<ProviderScenarioHarness, 'callCommand'>,
  steps: readonly ProviderScenarioStep[],
  defaults: ProviderScenarioDefaults = {},
): Promise<ProviderScenarioState> {
  const responses = new Map<string, ProviderScenarioRpcResult>();

  const state: ProviderScenarioState = {
    get responses() {
      return new Map(responses);
    },
    response(name) {
      const response = responses.get(name);
      assert.ok(response, `Missing provider-backed integration scenario response: ${name}`);
      return response;
    },
  };

  for (const step of steps) {
    const response = await daemon.callCommand(
      step.command,
      step.positionals,
      {
        ...defaults.flags,
        ...step.flags,
      },
      {
        meta: mergeRequestObject(defaults.meta, step.meta),
      },
    );
    const expectedStatus = step.expectStatus ?? 200;
    assert.equal(
      response.statusCode,
      expectedStatus,
      `${step.name} expected status ${expectedStatus}: ${JSON.stringify(response.json)}`,
    );
    if (expectedStatus === 200) {
      assert.ok(
        response.json?.result,
        `${step.name} returned JSON-RPC error: ${JSON.stringify(response.json?.error)}`,
      );
    }
    if (step.expectData) {
      assertDataContains(step.name, response, step.expectData);
    }
    responses.set(step.name, response);
    await step.assert?.(response, state);
  }

  return state;
}

function mergeRequestObject<T extends object>(
  base: T | undefined,
  override: T | undefined,
): T | undefined {
  if (!base) return override;
  if (!override) return base;
  return { ...base, ...override };
}

function assertDataContains(
  name: string,
  response: ProviderScenarioRpcResult,
  expected: Record<string, unknown>,
): void {
  const data = response.json?.result?.data;
  assert.ok(
    data && typeof data === 'object',
    `${name} did not return result data: ${JSON.stringify(response.json)}`,
  );
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(data[key], value, `${name} result data mismatch for ${key}`);
  }
}
