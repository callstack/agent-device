import nkzw from '@nkzw/oxlint-config';
import { defineConfig } from 'oxlint';

// Product source trees, where unit tests get scratch from the package tmp-dir helpers.
// scripts/, test/, and package test harnesses manage TMPDIR for child processes on purpose,
// so keeping the roots explicit holds them out of scope that a bare `**` would sweep in.
const PRODUCT_TEST_ROOTS = ['src', 'packages/*/src'];
const PRODUCT_TEST_SHAPES = [
  '**/*.test.ts',
  '**/*.fixtures.ts',
  '**/__tests__/**/*.ts',
  '**/test-utils/**/*.ts',
];
const PRODUCT_TEST_FILES = PRODUCT_TEST_ROOTS.flatMap((root) =>
  PRODUCT_TEST_SHAPES.map((shape) => `${root}/${shape}`),
);

// The last matching override replaces `no-restricted-imports` options instead of merging them,
// so each override restates every ban that applies to the files it matches.
const CHILD_PROCESS_PATH = {
  message:
    'Use process helpers from @agent-device/host-kit/command instead of importing node:child_process directly.',
  name: 'node:child_process',
};
const PROVIDER_IMPORT_PATTERN = {
  group: ['@agent-device/provider-*'],
  message:
    'Command implementations must ask src/cli/connection/provider-policy.ts for provider capabilities.',
};
const NODE_OS_PATH = {
  message:
    'Create test scratch with mkdtempForTest()/mkdtempForTestSync() from the package tmp-dir helper instead of reading node:os.',
  name: 'node:os',
};

const CHILD_PROCESS_BAN_ROOTS = ['src', 'packages/host-kit/src'];
const PROVIDER_BAN_ROOTS = ['src/commands', 'src/cli/commands'];

const MAX_FILE_LINES = 1000;

// Architecture debt: lower caps as files shrink; remove entries when files fit MAX_FILE_LINES.
const LEGACY_FILE_LINE_CAPS = {
  'packages/platform-android/src/__tests__/snapshot.test.ts': 1416,
  'packages/platform-apple/src/runner/__tests__/runner-client-command-retry.test.ts': 1064,
  'packages/platform-apple/src/runner/__tests__/runner-session.test.ts': 1456,
  'src/__tests__/agent-device-client.test.ts': 1271,
  'src/__tests__/cli-client-commands.test.ts': 1234,
  'src/__tests__/cli-config.test.ts': 1282,
  'src/__tests__/cli-network.test.ts': 1092,
  'src/__tests__/remote-connection.test.ts': 2324,
  'src/commands/interaction/runtime/settle.test.ts': 2094,
  'src/daemon-client/__tests__/daemon-client-lifecycle.test.ts': 1169,
  'src/daemon-client/__tests__/daemon-client.test.ts': 1340,
  'src/mcp/__tests__/command-tools.test.ts': 1029,
  'test/integration/provider-scenarios/android-lifecycle.test.ts': 1227,
  'packages/command-registry/src/registry.ts': 2159,
  'packages/host-kit/src/internal/exec.ts': 1032,
  'packages/react-native/src/metro/client-metro.ts': 1123,
  'src/cli/commands/connection-runtime.ts': 1019,
};

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
      files: ['**/*.test.{ts,tsx,mjs}'],
      rules: {
        'max-lines': ['error', { max: MAX_FILE_LINES }],
      },
    },
    {
      files: ['src/**/*.{ts,tsx,mjs}', 'packages/*/src/**/*.{ts,tsx,mjs}'],
      excludeFiles: ['**/*.test.*', '**/__tests__/**', '**/*.fixtures.*', '**/test-utils/**'],
      rules: {
        'max-lines': ['error', { max: MAX_FILE_LINES }],
      },
    },
    ...Object.entries(LEGACY_FILE_LINE_CAPS).map(([file, max]) => ({
      files: [file],
      rules: {
        'max-lines': ['error', { max }] as const,
      },
    })),
    {
      files: ['scripts/**/*.ts', 'scripts/**/*.mts', 'scripts/**/*.cts'],
      rules: {
        'no-undef': 'error',
      },
    },
    {
      files: CHILD_PROCESS_BAN_ROOTS.map((root) => `${root}/**/*.ts`),
      rules: {
        'no-restricted-imports': ['error', { paths: [CHILD_PROCESS_PATH] }],
      },
    },
    {
      files: PROVIDER_BAN_ROOTS.map((root) => `${root}/**/*.ts`),
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [CHILD_PROCESS_PATH],
            patterns: [PROVIDER_IMPORT_PATTERN],
          },
        ],
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
        'src/daemon-client/daemon-client-rpc.ts',
        'packages/daemon/src/server/downloadable-artifact-http.ts',
        'packages/remote/src/remote-request-diagnostics.ts',
        'packages/remote/src/upload-stream.ts',
      ],
      rules: {
        'unicorn/catch-error-name': 'off',
        'unicorn/prefer-string-replace-all': 'off',
      },
    },
    {
      files: [
        'packages/daemon/src/sessions/__tests__/replay-target/session-replay-target-verification-runtime.test.ts',
      ],
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
    {
      // Product tests get scratch from the package tmp-dir helpers, which honor the run's
      // redirected TMPDIR; reading node:os reuses a fixed path across the suite. A file with a
      // justified read (mocking production, a real socket path, or the TMPDIR mechanism itself)
      // oxlint-disables its one import line with a reason instead of widening this list.
      files: PRODUCT_TEST_FILES,
      rules: {
        'no-restricted-imports': ['error', { paths: [NODE_OS_PATH] }],
      },
    },
    {
      files: CHILD_PROCESS_BAN_ROOTS.flatMap((root) =>
        PRODUCT_TEST_SHAPES.map((shape) => `${root}/${shape}`),
      ),
      rules: {
        'no-restricted-imports': ['error', { paths: [CHILD_PROCESS_PATH, NODE_OS_PATH] }],
      },
    },
    {
      files: PROVIDER_BAN_ROOTS.flatMap((root) =>
        PRODUCT_TEST_SHAPES.map((shape) => `${root}/${shape}`),
      ),
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [CHILD_PROCESS_PATH, NODE_OS_PATH],
            patterns: [PROVIDER_IMPORT_PATTERN],
          },
        ],
      },
    },
    {
      // Tests may import node:child_process and provider packages directly.
      files: ['packages/host-kit/src/**/*.test.ts', 'src/**/*.test.ts', 'src/**/__tests__/**/*.ts'],
      rules: {
        'no-restricted-imports': ['error', { paths: [NODE_OS_PATH] }],
      },
    },
    {
      // The tmp-dir helper modules are the sanctioned os.tmpdir() readers.
      files: ['**/tmp-dir.ts', '**/tmp-dir.fixtures.ts'],
      rules: {
        'no-restricted-imports': ['error', { paths: [] }],
      },
    },
    {
      files: CHILD_PROCESS_BAN_ROOTS.flatMap((root) => [
        `${root}/**/tmp-dir.ts`,
        `${root}/**/tmp-dir.fixtures.ts`,
      ]),
      rules: {
        'no-restricted-imports': ['error', { paths: [CHILD_PROCESS_PATH] }],
      },
    },
    {
      // The host-kit process helpers are the sanctioned node:child_process importer.
      files: ['packages/host-kit/src/internal/exec.ts'],
      rules: {
        'no-restricted-imports': ['error', { paths: [] }],
      },
    },
  ],
});
