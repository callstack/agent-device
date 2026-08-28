import nkzw from '@nkzw/oxlint-config';
import { defineConfig } from 'oxlint';

export default defineConfig({
  env: {
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
    'import/default': 'error',
    'import/no-duplicates': 'error',
    'import/namespace': 'error',
    'import/no-namespace': 'off',
    'no-caller': 'error',
    'no-console': 'off',
    'no-empty': ['error', { allowEmptyCatch: true }],
    'no-eval': 'error',
    'no-iterator': 'error',
    'no-unassigned-vars': 'error',
    'no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        fix: {
          imports: 'safe-fix',
          variables: 'suggestion',
        },
        varsIgnorePattern: '^_',
      },
    ],
    'perfectionist/sort-object-types': 'off',
    'perfectionist/sort-objects': 'off',
    'typescript/no-this-alias': 'error',
    'typescript/no-unnecessary-parameter-property-assignment': 'error',
    'typescript/no-useless-empty-export': 'error',
    'unicorn/consistent-function-scoping': 'off',
    'unicorn/numeric-separators-style': 'off',
    'unicorn/prefer-top-level-await': 'off',
    'unicorn/prefer-structured-clone': 'off',
  },
  overrides: [
    {
      files: ['scripts/**/*.ts', 'scripts/**/*.mts', 'scripts/**/*.cts'],
      rules: {
        'no-undef': 'error',
      },
    },
    {
      files: ['src/**/*.ts', 'packages/host-kit/src/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              {
                name: 'node:child_process',
                message:
                  'Use process helpers from @agent-device/host-kit/command instead of importing node:child_process directly.',
              },
            ],
          },
        ],
      },
    },
    {
      files: [
        'packages/host-kit/src/internal/exec.ts',
        'packages/host-kit/src/**/*.test.ts',
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
