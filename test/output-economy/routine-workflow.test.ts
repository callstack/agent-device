import { describe, expect, test } from 'vitest';
import { renderRoutineWorkflow } from './routine-workflow.ts';

const { steps, error, measurement } = await renderRoutineWorkflow();

describe('routine-workflow output-behavior oracle', () => {
  test('runs one recorded routine session end to end', () => {
    expect(measurement.commandCount).toBe(7);
    expect(measurement.steps.map((step) => step.kind)).toEqual([
      'orient',
      'recheck',
      'mutation',
      'mutation',
      'read',
      'failure',
      'retry',
    ]);
    expect(measurement.totalBytes).toBeGreaterThan(0);
  });

  test('never needs a redundant observation to reach the next target', () => {
    // Every action targets a ref an earlier response already surfaced. If a
    // formatter dropped the settled diff's added refs or the unchanged-
    // interactive tail, the target would go unsurfaced and the agent would be
    // forced to re-observe — that is what this count catches.
    expect(measurement.fallbackObservationCount).toBe(0);

    const targeted = measurement.steps.filter((step) => step.targetRef);
    expect(targeted.length).toBeGreaterThan(0);
    for (const step of targeted) {
      expect(
        step.targetSurfacedBy,
        `${step.id} target ${step.targetRef} was not surfaced earlier`,
      ).toBeDefined();
    }
  });

  test('the settled diff, not a snapshot, surfaces the post-mutation targets', () => {
    const surfacedBy = Object.fromEntries(
      measurement.steps
        .filter((step) => step.targetRef)
        .map((step) => [step.targetRef, step.targetSurfacedBy]),
    );
    expect(surfacedBy['@e3']).toBe('orient');
    // @e5 (View receipt) exists only in the settled diff's added lines, never in
    // the orienting snapshot — so its surfacer proves the rendered diff, not a
    // re-observation, handed it over.
    expect(surfacedBy['@e5']).toBe('mutation-confirm');
    // @e7 (Continue) first appears in the removals-only settle's unchanged-
    // interactive tail, the only place it shows up before it is tapped.
    expect(surfacedBy['@e7']).toBe('mutation-tail');
  });

  test('exactly one recovery retry, driven by an actionable failure', () => {
    expect(measurement.retryCount).toBe(1);
    const failure = measurement.steps.find((step) => step.kind === 'failure');
    const retry = measurement.steps.find((step) => step.kind === 'retry');
    // The retry re-targets the same ref the failure was about; recovery stayed
    // in-session instead of re-orienting.
    expect(retry?.targetRef).toBe(failure?.targetRef);
  });

  test('the actionable failure preserves every recovery handle', () => {
    expect(measurement.recoveryPreservesSession).toBe(true);
    expect(measurement.recoveryFields).toEqual({
      code: 'COMMAND_FAILED',
      session: 'economy-fixture',
      refsGeneration: 14,
      retriable: true,
      hint: expect.stringContaining('Retry'),
    });
    // Recovery identity keys on structured details, not on message text.
    expect(error.details).toMatchObject({ reason: 'timeout', timeoutMs: 10_000, ref: '@e7' });
    expect(error.retriable).toBe(true);
  });

  test('unchanged snapshot suppression keeps the prior refs valid without re-emitting the tree', () => {
    const recheck = steps.find((step) => step.id === 'recheck');
    const text =
      recheck?.samples.cli && 'text' in recheck.samples.cli ? recheck.samples.cli.text : '';
    expect(text).toContain('unchanged');
    expect(text).toContain('refs are still valid');
    // The suppression is strictly cheaper than the orienting snapshot it repeats.
    const orientBytes = measurement.steps.find((step) => step.id === 'orient')!.bytes;
    const recheckBytes = measurement.steps.find((step) => step.id === 'recheck')!.bytes;
    expect(recheckBytes).toBeLessThan(orientBytes);
  });

  test('CLI and MCP projections of the orienting snapshot both carry the actionable refs', () => {
    const orient = steps.find((step) => step.id === 'orient')!;
    const cliText =
      orient.samples.cli && 'text' in orient.samples.cli ? orient.samples.cli.text : '';
    expect(cliText).toContain('@e3 [button] "Place order"');

    const mcp =
      orient.samples.mcp && 'data' in orient.samples.mcp ? orient.samples.mcp.data : undefined;
    expect(mcp).toMatchObject({
      isError: false,
      structuredContent: { refsGeneration: 12 },
      content: [{ type: 'text', text: expect.stringContaining('@e3 [button] "Place order"') }],
    });
  });
});
