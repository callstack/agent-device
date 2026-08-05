import { describe, expect, test } from 'vitest';
import { composeMcpDescription, projectCommandGuidance } from './command-guidance.ts';

describe('projectCommandGuidance', () => {
  test('projects one canonical body with a per-surface tail', () => {
    const guidance = projectCommandGuidance(
      'Open an app.',
      { summary: 'Open an app', helpDescription: 'Open an app or URL in the selected session.' },
      {
        cliDetail: 'macOS also supports --surface app|desktop.',
        mcpDetail: 'Prefer this over booting the device separately.',
      },
    );

    // The canonical body is what every non-MCP consumer reads, unmodified.
    expect(guidance.description).toBe('Open an app or URL in the selected session.');
    expect(guidance.cliSchema?.helpDescription).toBe(
      'Open an app or URL in the selected session. macOS also supports --surface app|desktop.',
    );
    expect(composeMcpDescription(guidance)).toBe(
      'Open an app or URL in the selected session. Prefer this over booting the device separately.',
    );
  });

  test('keeps CLI-only flag guidance out of the MCP description', () => {
    const guidance = projectCommandGuidance('Open an app.', undefined, {
      cliDetail: 'Use --surface to pick a macOS surface.',
    });

    expect(composeMcpDescription(guidance)).toBe('Open an app.');
    expect(guidance.cliSchema?.helpDescription).toContain('--surface');
  });

  test('never falls back to the short list-view summary', () => {
    const guidance = projectCommandGuidance(
      'Boot or prepare a selected device without using CLI positional arguments.',
      { summary: 'Boot target device/simulator' },
      undefined,
    );

    expect(guidance.description).toBe(
      'Boot or prepare a selected device without using CLI positional arguments.',
    );
    expect(guidance.cliSchema?.helpDescription).toBe(guidance.description);
  });

  test('leaves commands without a CLI schema or guidance untouched', () => {
    const guidance = projectCommandGuidance('Show foreground app.', undefined, undefined);

    expect(guidance.cliSchema).toBeUndefined();
    expect(guidance.description).toBe('Show foreground app.');
    expect(guidance.mcpDetail).toBeUndefined();
  });
});
