import { describe, expect, test } from 'vitest';
import { projectCommandGuidance } from './command-guidance.ts';

describe('projectCommandGuidance', () => {
  test('keeps CLI-only flag guidance out of the MCP description and injects selected MCP inputs', () => {
    const guidance = projectCommandGuidance(
      'Open an app.',
      { helpDescription: 'Open an app with --surface.' },
      {
        properties: {
          app: { description: 'App name or bundle identifier.' },
          surface: { description: 'macOS presentation surface.' },
        },
      },
      {
        mcp: {
          description: 'Open an app or URL in the selected session.',
          parameters: ['app', 'surface'],
        },
        cli: { flags: ['surface'] },
      },
    );

    expect(guidance.cliSchema?.helpDescription).toBe(
      'Open an app with --surface. Relevant flags: --surface.',
    );
    expect(guidance.mcpDescription).toBe(
      'Open an app or URL in the selected session. Key inputs: app: App name or bundle identifier. surface: macOS presentation surface.',
    );
  });
});
