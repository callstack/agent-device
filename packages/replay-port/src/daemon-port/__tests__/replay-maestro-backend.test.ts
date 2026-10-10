import { expect, test } from 'vitest';
import { maestroBackend } from '../replay-maestro-backend.ts';

// The backend adapter maps the host's capability vocabulary onto the engine's façade. The hosts
// that consume it (source discovery, request device binding, `replay export`, the replay command)
// each test the behavior through the registry; what is pinned here is the adapter's own mapping,
// which is the contract the 0.22 plugin (#3377) relocates unchanged.

test('inspectSource reports the flow title and static app target', () => {
  const inspection = maestroBackend.inspectSource(
    ['appId: com.example.app', 'name: Checkout', '---', '- launchApp'].join('\n'),
    '/flows/checkout.yaml',
  );
  expect(inspection).toEqual({ title: 'Checkout', appTarget: 'com.example.app' });
});

test('collectSourceFiles expands runFlow includes through the reader it is given', () => {
  const includes: Record<string, string> = {
    '/flows/login.yaml': ['appId: com.example.app', '---', '- launchApp'].join('\n'),
  };
  const files = maestroBackend.collectSourceFiles({
    entryPath: '/flows/main.yaml',
    entrySource: [
      'appId: com.example.app',
      '---',
      '- launchApp',
      '- runFlow:',
      '    file: ./login.yaml',
    ].join('\n'),
    readSource: (path) => includes[path],
  });
  expect(Object.keys(files)).toEqual(['/flows/main.yaml', '/flows/login.yaml']);
});

test('exportReplayScript converts actions to Maestro YAML and reports its warnings', () => {
  const result = maestroBackend.exportReplayScript(
    [{ command: 'open', positionals: ['com.example.app'], ts: 0, flags: {} }],
    {},
  );
  expect(result.yaml).toContain('com.example.app');
  expect(result.warnings).toEqual([]);
});
