import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'provider-integration',
          include: ['test/integration/provider-scenarios/**/*.test.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      thresholds: {
        statements: 78,
        lines: 80,
      },
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/__tests__/**',
        'src/**/*-types.ts',
        'src/**/types.ts',
        'src/android-adb.ts',
        'src/artifacts.ts',
        'src/batch.ts',
        'src/bin.ts',
        'src/client-types.ts',
        'src/core/interactor-types.ts',
        'src/index.ts',
        'src/install-source.ts',
        'src/remote/remote-config.ts',
        'src/selectors.ts',
      ],
    },
  },
});
