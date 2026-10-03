import { describe, expect, test } from 'vitest';
import {
  isMaestroYamlPath,
  maestroBackendRequiredMessage,
  resolveReplayFormat,
} from '../format.ts';

describe('resolveReplayFormat', () => {
  test('keeps .ad on the native engine even when Maestro is requested', () => {
    expect(resolveReplayFormat('/flows/login.ad', 'maestro')).toBe('ad');
  });

  test.each(['/flows/login.yaml', '/flows/login.yml'])(
    'routes %s to Maestro only when explicitly requested',
    (sourcePath) => {
      expect(resolveReplayFormat(sourcePath, 'maestro')).toBe('maestro');
      expect(resolveReplayFormat(sourcePath, undefined)).toBe('ad');
    },
  );

  test('identifies Maestro YAML by extension without reading contents', () => {
    expect(isMaestroYamlPath('/flows/login.YML')).toBe(true);
    expect(isMaestroYamlPath('/flows/login.ad')).toBe(false);
  });

  test('formats the explicit routing diagnostic', () => {
    expect(maestroBackendRequiredMessage('replay', '/flows/login.yaml')).toBe(
      'Maestro YAML requires explicit --maestro routing: replay /flows/login.yaml --maestro',
    );
  });
});
