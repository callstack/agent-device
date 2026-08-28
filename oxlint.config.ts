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
    'perfectionist/sort-interfaces': 'off',
    'perfectionist/sort-jsx-props': 'off',
    'typescript/await-thenable': 'error',
    'typescript/no-array-delete': 'error',
    'typescript/no-base-to-string': 'error',
    'typescript/no-duplicate-type-constituents': 'error',
    'typescript/no-floating-promises': 'error',
    'typescript/no-for-in-array': 'error',
    'typescript/no-implied-eval': 'error',
    'typescript/no-meaningless-void-operator': 'error',
    'typescript/no-misused-spread': 'error',
    'typescript/no-redundant-type-constituents': 'error',
    'typescript/no-this-alias': 'error',
    'typescript/no-unnecessary-parameter-property-assignment': 'error',
    'typescript/no-unsafe-unary-minus': 'error',
    'typescript/no-useless-default-assignment': 'error',
    'typescript/no-useless-empty-export': 'error',
    'typescript/require-array-sort-compare': 'error',
    'typescript/restrict-template-expressions': 'error',
    'typescript/unbound-method': 'error',
    'unicorn/consistent-function-scoping': 'off',
    'unicorn/numeric-separators-style': 'off',
    'unicorn/prefer-top-level-await': 'off',
    'unicorn/prefer-structured-clone': 'off',
  },
  overrides: [
    {
      files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
      rules: {
        'no-undef': 'error',
      },
    },
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
      env: {
        browser: true,
      },
      rules: {
        'react/immutability': 'off',
        'react/purity': 'off',
        'react/refs': 'off',
      },
    },
    {
      files: ['examples/test-app/src/**/*.ts', 'examples/test-app/src/**/*.tsx'],
      globals: {
        __DEV__: 'readonly',
      },
    },
    {
      files: ['src/core/command-descriptor/registry.ts'],
      globals: {
        __OWNER_FILES__: 'readonly',
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
