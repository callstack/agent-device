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
  /** A factory is invoked per call, so repeated calls can return fresh results. */
  result?: TResult | (() => TResult);
  /**
   * Serves every matching call instead of being consumed by the first, and never
   * counts as unconsumed. Use it where the call COUNT is not the contract — a
   * quiet UI returns the same tree to every capture, a busy one returns a fresh
   * tree per capture (pair with a `result` factory). Scripting an exact count
   * there would assert the runner's speed rather than the behaviour.
   *
   * A repeat is the FALLBACK for its command: matching one-shot entries are
   * always served first, whatever order the entries are declared in, so a
   * repeat can never strand one. Unsupported in ordered transcripts, where a
   * repeat would never advance the queue.
   */
  repeat?: boolean;
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
  if (options.ordered && entries.some((entry) => entry.repeat)) {
    throw new Error(
      'Ordered provider transcripts cannot use `repeat` entries: ordered lookup only reads the head, so a repeat never advances and strands every entry behind it.',
    );
  }
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
      const entryIndex = options.ordered ? 0 : findEntryIndex(pending, command, request, scope);
      const entry = entryIndex >= 0 ? pending[entryIndex] : undefined;
      assert.ok(entry, `Unexpected provider call: ${formatCall(command, scope)}`);
      if (!entry.repeat) pending.splice(entryIndex, 1);
      assert.equal(command, entry.command, 'Provider command mismatch');
      assertScope(scope, entry);
      if (Object.hasOwn(entry, 'request')) {
        assert.deepEqual(request, entry.request, 'Provider request mismatch');
      }

      const result = resolveEntryResult(entry) as TResult;
      const call = {
        command,
        request,
        deviceId: scope.deviceId,
        platform: scope.platform,
        result,
      };
      calls.push(call);

      if (entry.error) {
        throw entry.error instanceof Error ? entry.error : new Error(entry.error);
      }

      return result;
    },
    assertComplete() {
      const outstanding = pending.filter((entry) => !entry.repeat);
      assert.equal(
        outstanding.length,
        0,
        `Unconsumed provider transcript entries: ${outstanding.map(formatEntry).join(', ')}`,
      );
    },
  };
}

export function createOrderedProviderTranscript(
  entries: readonly ProviderScenarioProviderEntry[],
): ProviderScenarioTranscript {
  return createProviderTranscript(entries, { ordered: true });
}

/**
 * One-shot entries are served before repeats regardless of declaration order: a
 * repeat is its command's fallback, so taking the first match would let one
 * shadow a one-shot forever and strand it as permanently unconsumed.
 */
function findEntryIndex(
  pending: readonly ProviderScenarioProviderEntry[],
  command: string,
  request: unknown,
  scope: ProviderScenarioProviderScope,
): number {
  const matches = (candidate: ProviderScenarioProviderEntry): boolean =>
    providerEntryMatches(candidate, command, request, scope);
  const oneShotIndex = pending.findIndex((candidate) => !candidate.repeat && matches(candidate));
  return oneShotIndex >= 0 ? oneShotIndex : pending.findIndex(matches);
}

function resolveEntryResult(entry: ProviderScenarioProviderEntry): unknown {
  return typeof entry.result === 'function' ? (entry.result as () => unknown)() : entry.result;
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
