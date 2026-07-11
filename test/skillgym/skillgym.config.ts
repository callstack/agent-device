import type { SkillgymConfig } from 'skillgym';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enforceSkillGymRunnerEnvironment } from './runner-environment.ts';

enforceSkillGymRunnerEnvironment();

const localBinDir = fileURLToPath(new URL('./bin', import.meta.url));
const runnerEnv = {
  PATH: [localBinDir, process.env.PATH].filter(Boolean).join(path.delimiter),
};

const gatewayAuthToken = process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_OIDC_TOKEN;
const gatewayOpenCodeConfig = {
  provider: {
    'vercel-gateway': {
      npm: '@ai-sdk/openai-compatible',
      name: 'Vercel AI Gateway',
      options: {
        apiKey: gatewayAuthToken,
        baseURL: 'https://ai-gateway.vercel.sh/v1',
      },
      models: {
        'openai/gpt-5.4-nano': {
          name: 'GPT 5.4 Nano',
        },
      },
    },
  },
};

const runners: SkillgymConfig['runners'] = {
  'codex-mini': {
    agent: {
      type: 'codex',
      model: 'gpt-5.4-mini',
      env: runnerEnv,
    },
  },
  'claude-haiku': {
    agent: {
      type: 'claude-code',
      model: 'haiku',
      env: runnerEnv,
    },
  },
};

if (process.env.SKILLGYM_ENABLE_VERCEL_GATEWAY === '1') {
  if (gatewayAuthToken === undefined || gatewayAuthToken.length === 0) {
    throw new Error(
      'SKILLGYM_ENABLE_VERCEL_GATEWAY=1 requires AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN.',
    );
  }

  runners['gpt-nano-gateway'] = {
    agent: {
      type: 'opencode',
      command: 'opencode',
      model: 'vercel-gateway/openai/gpt-5.4-nano',
      env: {
        ...runnerEnv,
        AI_GATEWAY_API_KEY: gatewayAuthToken,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(gatewayOpenCodeConfig),
      },
    },
  };
}

const config: SkillgymConfig = {
  run: {
    // Relative to this config file; points SkillGym at the repository root.
    cwd: '../..',
    outputDir: '.skillgym-results',
    reporter: 'standard',
    schedule: 'parallel',
  },
  defaults: {
    timeoutMs: 600_000,
  },
  runners,
};

export default config;
