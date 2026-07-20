import type { JsonSchema } from '../commands/command-contract.ts';
import { DEVICE_TARGETS, PUBLIC_PLATFORMS } from '../kernel/device.ts';
import { COMMAND_OUTPUT_SCHEMAS, DEVICE_KINDS } from './command-output-schemas.ts';

const MCP_COLLECTION_OUTPUT_SCHEMAS = {
  devices: {
    type: 'object',
    properties: {
      devices: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            platform: { type: 'string', enum: PUBLIC_PLATFORMS },
            target: { type: 'string', enum: DEVICE_TARGETS },
            kind: { type: 'string', enum: DEVICE_KINDS },
            id: { type: 'string' },
            name: { type: 'string' },
          },
          required: ['platform', 'target', 'kind', 'id', 'name'],
        },
      },
    },
    required: ['devices'],
  },
  apps: {
    type: 'object',
    properties: {
      apps: { type: 'array', items: { type: 'string' } },
    },
    required: ['apps'],
  },
} as const satisfies Record<'devices' | 'apps', JsonSchema>;

export const MCP_COMMAND_OUTPUT_SCHEMAS = {
  ...COMMAND_OUTPUT_SCHEMAS,
  ...MCP_COLLECTION_OUTPUT_SCHEMAS,
} as const;
