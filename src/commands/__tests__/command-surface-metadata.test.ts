import assert from 'node:assert/strict';
import { test } from 'vitest';
import { listCliCommandNames } from '../../command-catalog.ts';
import {
  listCommandResponseDataTransforms,
  listMcpExposedCommandNames,
} from '../../core/command-descriptor/registry.ts';
import { getSchemaOnlyCliCommandSchema } from '../../cli-schema/command-overrides.ts';
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
import { helpBody, mcpBody } from '../command-text.ts';
import { explainCommand } from '../command-explain.ts';
import { getDaemonRouteOwnerFiles } from '../../daemon/route-owner-files.ts';

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

test('every surface reports the same canonical description', () => {
  const cliSchemas = listCommandFamilyCliSchemas();
  const definitionsByName = new Map(
    listCommandFamilyDefinitions().map((definition) => [definition.name, definition] as const),
  );

  for (const metadata of listCommandMetadata()) {
    const definition = definitionsByName.get(metadata.name);
    assert.equal(
      definition?.description,
      metadata.description,
      `${metadata.name}: executable definition description drifted from metadata`,
    );
    assert.equal(
      describeCommand(metadata.name),
      metadata.description,
      `${metadata.name}: explain reports a description other than the canonical body`,
    );
    const text = cliSchemas[metadata.name]?.text;
    assert.ok(text, `${metadata.name}: missing command text`);
    assert.equal(
      text.description,
      metadata.description,
      `${metadata.name}: CLI text description drifted from metadata`,
    );
    // Surfaces may only extend the body, never replace it.
    assert.ok(
      helpBody(text).startsWith(metadata.description),
      `${metadata.name}: help replaces body`,
    );
    assert.ok(
      mcpBody(metadata).startsWith(metadata.description),
      `${metadata.name}: MCP replaces body`,
    );
  }
});

test('every command states a summary that is shorter than its description', () => {
  for (const [name, schema] of Object.entries(listCommandFamilyCliSchemas())) {
    const { summary, description } = schema.text;
    assert.ok(summary.length > 0, `${name}: summary must not be empty`);
    assert.ok(
      summary.length <= 72,
      `${name}: summary is ${summary.length} chars; the command list wants one short line`,
    );
    assert.ok(
      !summary.endsWith('.'),
      `${name}: summary should read as a label, without a trailing period`,
    );
    // Compare loosely: `push` differed from its description only by a trailing period.
    assert.notEqual(
      summary
        .toLowerCase()
        .replaceAll(/[^a-z0-9 ]/g, '')
        .trim(),
      description
        .toLowerCase()
        .replaceAll(/[^a-z0-9 ]/g, '')
        .trim(),
      `${name}: summary duplicates the description`,
    );
  }
});

test('open keeps flag guidance on the CLI surface only', () => {
  const cliSchemas = listCommandFamilyCliSchemas();
  const open = listMcpCommandMetadata().find((metadata) => metadata.name === 'open');
  assert.match(mcpBody(open!), /foreground automation target/);
  assert.match(helpBody(cliSchemas.open!.text), /foreground automation target/);
  assert.match(helpBody(cliSchemas.open!.text), /--launch-console/);
});

test('MCP tool descriptions avoid CLI syntax', () => {
  const cliSyntax = [/--[a-z]/, /<[^>]+>|\[[^\]]+\]/, /agent-device/, /\bpositional\b/];
  for (const metadata of listMcpCommandMetadata()) {
    const description = mcpBody(metadata);
    for (const pattern of cliSyntax) {
      assert.doesNotMatch(description, pattern, `${metadata.name} contains CLI syntax`);
    }
  }
});

test('common command input accepts web platform selector', () => {
  const snapshotMetadata = listCommandMetadata().find((metadata) => metadata.name === 'snapshot');
  if (!snapshotMetadata) throw new Error('Expected snapshot command metadata');

  const platformSchema = snapshotMetadata.inputSchema.properties?.platform;
  const input = snapshotMetadata.readInput({ platform: 'web' }) as {
    platform?: unknown;
  };
  assert.deepEqual(platformSchema?.enum, [
    'apple',
    'android',
    'harmonyos',
    'vega',
    'linux',
    'web',
    'ios',
    'macos',
  ]);
  assert.equal(input.platform, 'web');
});

test('trigger-app-event rejects non-object payloads at command input read time', () => {
  const metadata = listCommandMetadata().find((entry) => entry.name === 'trigger-app-event');
  if (!metadata) throw new Error('Expected trigger-app-event command metadata');

  assert.throws(
    () =>
      metadata.readInput({
        event: 'screenshot_taken',
        payload: 'not-json-object',
      }),
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
  assert.ok(writerNames.length > 0);
  for (const name of writerNames) {
    assert.ok(metadataNames.has(name), `${name} daemon writer must belong to command metadata`);
  }
});

// The device-selector descriptions are a public machine surface (MCP/Node input schemas) and
// must state the same platform facts as the resolver and the CLI help: a UDID belongs in udid,
// --serial covers HarmonyOS (#2064). Pinned here so a drift on any command's emitted schema
// fails instead of shipping a cross-surface mismatch.
test('every emitted input schema carries the aligned device-selector descriptions', () => {
  const expected: Record<string, string> = {
    device: 'Device name selector (a UDID belongs in udid, a serial in serial).',
    udid: 'Apple device or simulator UDID; the selector that pins one device when several share a name.',
    serial: 'Android, HarmonyOS, or Vega VVD serial selector.',
  };
  let pinned = 0;
  for (const metadata of listCommandMetadata()) {
    const properties = (
      metadata.inputSchema as { properties?: Record<string, { description?: string }> }
    ).properties;
    if (!properties) continue;
    for (const [key, description] of Object.entries(expected)) {
      const property: { description?: string } | undefined = properties[key];
      if (!property) continue;
      assert.equal(property.description, description, `${metadata.name}.${key}`);
      pinned += 1;
    }
  }
  assert.ok(pinned > 0, 'expected at least one command schema to carry the device selectors');
});

const daemonRouteOwnerFiles = getDaemonRouteOwnerFiles();

function describeCommand(name: string): string | undefined {
  const result = explainCommand(name, { daemonRouteOwnerFiles });
  return result.found ? result.explanation.description : undefined;
}
