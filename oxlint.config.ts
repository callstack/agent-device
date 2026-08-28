import nkzw from '@nkzw/oxlint-config';
import { defineConfig } from 'oxlint';

export default defineConfig({
  env: {
    browser: true,
    builtin: true,
    es2024: true,
    node: true,
  },
  extends: [nkzw],
  ignorePatterns: ['dist/**', 'node_modules/**'],
  rules: {
    '@typescript-eslint/array-type': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    '@nkzw/no-instanceof': 'off',
    curly: 'off',
    'import/no-duplicates': 'error',
    'import/no-namespace': 'off',
    'no-console': 'off',
    'no-empty': ['error', { allowEmptyCatch: true }],
    'perfectionist/sort-object-types': 'off',
    'perfectionist/sort-objects': 'off',
    'perfectionist/sort-interfaces': 'off',
    'perfectionist/sort-jsx-props': 'off',
    'unicorn/consistent-function-scoping': 'off',
    'unicorn/numeric-separators-style': 'off',
    'unicorn/prefer-top-level-await': 'off',
    'unicorn/prefer-structured-clone': 'off',
  },
  overrides: [
    {
      files: ['src/**/*.ts', 'packages/capture-kit/src/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              {
                name: 'node:child_process',
                message:
                  'Use process helpers from @agent-device/capture-kit/exec instead of importing node:child_process directly.',
              },
            ],
          },
        ],
      },
    },
    {
      files: [
        'packages/capture-kit/src/exec.ts',
        'packages/capture-kit/src/*.test.ts',
        'src/**/*.test.ts',
        'src/**/__tests__/**/*.ts',
      ],
      rules: {
        'no-restricted-imports': ['error', { paths: [] }],
      },
    },
    {
      files: ['examples/test-app/src/**/*.tsx'],
      rules: {
        'react/immutability': 'off',
        'react/purity': 'off',
        'react/refs': 'off',
      },
    },
    {
      files: ['examples/test-app/app.config.js'],
      rules: {
        '@typescript-eslint/no-require-imports': 'off',
      },
    },
    {
      files: [
        'src/daemon/client/daemon-client-rpc.ts',
        'src/daemon/downloadable-artifact-http.ts',
        'src/remote/remote-request-diagnostics.ts',
        'src/remote/upload-stream.ts',
      ],
      rules: {
        'unicorn/catch-error-name': 'off',
        'unicorn/prefer-string-replace-all': 'off',
      },
    },
    {
      files: ['src/daemon/handlers/__tests__/session-replay-target-verification-runtime.test.ts'],
      rules: {
        'unicorn/prefer-string-raw': 'off',
      },
    },
    {
      files: ['scripts/maestro-conformance/corpus/authored/runscript.js'],
      globals: {
        output: 'writable',
      },
    },
  ],
});
