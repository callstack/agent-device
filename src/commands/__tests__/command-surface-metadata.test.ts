import assert from 'node:assert/strict';
import { test } from 'vitest';
import { listCliCommandNames } from '../../command-catalog.ts';
import {
  listCommandResponseDataTransforms,
  listMcpExposedCommandNames,
} from '../../core/command-descriptor/registry.ts';
import { getSchemaOnlyCliCommandSchema } from '../../utils/cli-command-overrides.ts';
import {
  listCommandMetadata,
  listCommandMetadataNames,
  listMcpCommandMetadata,
} from '../command-metadata.ts';
import {
  commandFamilies,
  listCommandFamilyCliReaders,
  listCommandFamilyCliSchemas,
  listCommandFamilyDaemonWriters,
  listCommandFamilyDefinitions,
  listCommandFamilyMetadata,
} from '../family/registry.ts';
import { listExecutableCommandNames } from '../command-surface.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import { defineCommandFacet, defineCommandFamilyFromFacets } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';

test('MCP exposed command names have metadata and executable command definitions', () => {
  const mcpExposedNames = listMcpExposedCommandNames().sort();
  const mcpMetadataNames = listMcpCommandMetadata()
    .map((definition) => definition.name)
    .sort();
  const metadataNames = new Set<string>(listCommandMetadataNames());
  const executableNames = new Set<string>(listExecutableCommandNames());

  assert.deepEqual(mcpMetadataNames, mcpExposedNames);

  for (const name of mcpExposedNames) {
    assert.ok(metadataNames.has(name), `${name} must have command metadata`);
    assert.ok(executableNames.has(name), `${name} must have an executable command definition`);
  }
});

test('CI-only prepare command stays out of MCP tool surface', () => {
  assert.equal(listMcpExposedCommandNames().includes('prepare'), false);
});

test('common command input accepts web platform selector', () => {
  const snapshotMetadata = listCommandMetadata().find((metadata) => metadata.name === 'snapshot');
  if (!snapshotMetadata) throw new Error('Expected snapshot command metadata');

  const platformSchema = snapshotMetadata.inputSchema.properties?.platform;
  const input = snapshotMetadata.readInput({ platform: 'web' }) as { platform?: unknown };
  assert.deepEqual(platformSchema?.enum, ['apple', 'android', 'linux', 'web', 'ios', 'macos']);
  assert.equal(input.platform, 'web');
});

test('trigger-app-event rejects non-object payloads at command input read time', () => {
  const metadata = listCommandMetadata().find((entry) => entry.name === 'trigger-app-event');
  if (!metadata) throw new Error('Expected trigger-app-event command metadata');

  assert.throws(
    () => metadata.readInput({ event: 'screenshot_taken', payload: 'not-json-object' }),
    /Expected payload to be an object\./,
  );
});

test('command response data transforms reference command input fields', () => {
  const metadataByName = new Map<string, ReturnType<typeof listCommandMetadata>[number]>(
    listCommandMetadata().map((metadata) => [metadata.name, metadata] as const),
  );

  for (const { command, transform } of listCommandResponseDataTransforms()) {
    const metadata = metadataByName.get(command);
    assert.ok(metadata, `${command} response data transform must have command metadata`);

    const inputFields = new Set(Object.keys(metadata.inputSchema.properties ?? {}));
    for (const field of Object.keys(transform.fields)) {
      assert.ok(
        inputFields.has(field),
        `${command} response data transform field ${field} must be declared by command input metadata`,
      );
    }
  }
});

test('command family facets expose one complete metadata and executable surface', () => {
  const familyNames = commandFamilies.map((family) => family.name);
  assert.deepEqual(familyNames, [...new Set(familyNames)], 'command family names must be unique');

  const metadataNames = listCommandFamilyMetadata()
    .map((metadata) => metadata.name)
    .sort();
  const definitionNames = listCommandFamilyDefinitions()
    .map((definition) => definition.name)
    .sort();

  assert.deepEqual(definitionNames, metadataNames);
  assert.deepEqual(metadataNames, listCommandMetadataNames());
  assert.deepEqual(definitionNames, listExecutableCommandNames());
});

test('descriptor CLI catalog and command surface metadata stay coherent', () => {
  const cliCommandNames = listCliCommandNames();
  const cliCommandNameSet = new Set<string>(cliCommandNames);
  const metadataNames = listCommandMetadataNames();
  const metadataNameSet = new Set<string>(metadataNames);

  for (const name of metadataNames) {
    assert.ok(cliCommandNameSet.has(name), `${name} command metadata must have a descriptor`);
  }

  for (const name of cliCommandNames) {
    if (metadataNameSet.has(name)) continue;
    assert.ok(
      getSchemaOnlyCliCommandSchema(name),
      `${name} descriptor CLI command needs metadata or a schema-only CLI schema`,
    );
  }
});

test('command family facets expose CLI schema and reader coverage centrally', () => {
  const metadataNames = listCommandFamilyMetadata()
    .map((metadata) => metadata.name)
    .sort();
  const cliSchemaNames = Object.keys(listCommandFamilyCliSchemas()).sort();
  const cliReaderNames = Object.keys(listCommandFamilyCliReaders()).sort();
  const metadataNameSet = new Set<string>(metadataNames);

  assert.deepEqual(cliReaderNames, metadataNames);
  for (const name of cliSchemaNames) {
    assert.ok(metadataNameSet.has(name), `${name} CLI schema must belong to command metadata`);
  }
});

test('command family facets keep daemon writers as an explicit projection subset', () => {
  const writerNames = Object.keys(listCommandFamilyDaemonWriters()).sort();
  const metadataNames = new Set<string>(
    listCommandFamilyMetadata().map((metadata) => metadata.name),
  );
  const projectionAliases = new Set([
    'gesture-fling',
    'gesture-pan',
    'gesture-pinch',
    'gesture-rotate',
    'gesture-swipe',
    'gesture-transform',
  ]);

  assert.ok(writerNames.length > 0);
  for (const name of writerNames) {
    assert.ok(
      metadataNames.has(name) || projectionAliases.has(name),
      `${name} daemon writer must belong to command metadata or projection aliases`,
    );
  }
});

test('command family facets reject duplicate daemon writer keys', () => {
  const metadata = defineFieldCommandMetadata('example', 'Example command.', {});
  const definition = defineExecutableCommand(metadata, async () => ({}));
  const writer = () => ({ command: 'example', positionals: [], options: {} });

  const facet = defineCommandFacet({
    name: 'example',
    metadata,
    definition,
    cliReader: () => ({}),
    daemonWriter: writer,
    extraDaemonWriters: { example: writer },
  });

  assert.throws(
    () => defineCommandFamilyFromFacets({ name: 'test', commands: [facet] }),
    /Duplicate command family daemon writer: example/,
  );
});
