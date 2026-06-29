import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import type { Platform } from '../../../src/kernel/device.ts';

export interface ProviderScenarioProviderScope {
  deviceId?: string;
  platform?: Platform;
}

export interface ProviderScenarioProviderEntry<
  TResult = unknown,
> extends ProviderScenarioProviderScope {
  command: string;
  request?: unknown;
  result?: TResult;
  error?: Error | string;
}

export interface ProviderScenarioProviderCall<
  TResult = unknown,
> extends ProviderScenarioProviderScope {
  command: string;
  request?: unknown;
  result?: TResult;
}

export interface ProviderScenarioTranscript {
  readonly calls: readonly ProviderScenarioProviderCall[];
  readonly remaining: readonly ProviderScenarioProviderEntry[];
  next<TResult = unknown>(
    command: string,
    request?: unknown,
    scope?: ProviderScenarioProviderScope,
  ): TResult;
  assertComplete(): void;
}

export function createProviderTranscript(
  entries: readonly ProviderScenarioProviderEntry[],
  options: { ordered?: boolean } = {},
): ProviderScenarioTranscript {
  const pending = [...entries];
  const calls: ProviderScenarioProviderCall[] = [];

  return {
    get calls() {
      return [...calls];
    },
    get remaining() {
      return [...pending];
    },
    next<TResult = unknown>(
      command: string,
      request?: unknown,
      scope: ProviderScenarioProviderScope = {},
    ): TResult {
      const entryIndex = options.ordered
        ? 0
        : pending.findIndex((candidate) =>
            providerEntryMatches(candidate, command, request, scope),
          );
      const entry = entryIndex >= 0 ? pending.splice(entryIndex, 1)[0] : undefined;
      assert.ok(entry, `Unexpected provider call: ${formatCall(command, scope)}`);
      assert.equal(command, entry.command, 'Provider command mismatch');
      assertScope(scope, entry);
      if (Object.hasOwn(entry, 'request')) {
        assert.deepEqual(request, entry.request, 'Provider request mismatch');
      }

      const call = {
        command,
        request,
        deviceId: scope.deviceId,
        platform: scope.platform,
        result: entry.result as TResult,
      };
      calls.push(call);

      if (entry.error) {
        throw entry.error instanceof Error ? entry.error : new Error(entry.error);
      }

      return entry.result as TResult;
    },
    assertComplete() {
      assert.equal(
        pending.length,
        0,
        `Unconsumed provider transcript entries: ${pending.map(formatEntry).join(', ')}`,
      );
    },
  };
}

export function createOrderedProviderTranscript(
  entries: readonly ProviderScenarioProviderEntry[],
): ProviderScenarioTranscript {
  return createProviderTranscript(entries, { ordered: true });
}

function providerEntryMatches(
  entry: ProviderScenarioProviderEntry,
  command: string,
  request: unknown,
  scope: ProviderScenarioProviderScope,
): boolean {
  if (entry.command !== command) return false;
  if (entry.deviceId && entry.deviceId !== scope.deviceId) return false;
  if (entry.platform && entry.platform !== scope.platform) return false;
  return !Object.hasOwn(entry, 'request') || isDeepStrictEqual(request, entry.request);
}

function assertScope(
  actual: ProviderScenarioProviderScope,
  expected: ProviderScenarioProviderEntry,
): void {
  if (expected.deviceId) {
    assert.equal(actual.deviceId, expected.deviceId, 'Provider device id mismatch');
  }
  if (expected.platform) {
    assert.equal(actual.platform, expected.platform, 'Provider platform mismatch');
  }
}

function formatCall(command: string, scope: ProviderScenarioProviderScope): string {
  return formatEntry({ command, ...scope });
}

function formatEntry(entry: { command: string; deviceId?: string; platform?: Platform }): string {
  const scope = [entry.platform, entry.deviceId].filter(Boolean).join(':');
  return scope ? `${scope}.${entry.command}` : entry.command;
}
