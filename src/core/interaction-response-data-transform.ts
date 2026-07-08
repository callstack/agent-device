import {
  listCommandResponseDataTransformFieldNames,
  resolveCommandResponseDataTransform,
} from './command-descriptor/registry.ts';
import type { ResponseDataFieldTransform } from './command-descriptor/types.ts';

export type InteractionResponseDataTransformCommand = 'click' | 'press' | 'fill';

const controlledResponseDataFieldNames = new Set(listCommandResponseDataTransformFieldNames());

export function transformInteractionResponseData(params: {
  command: InteractionResponseDataTransformCommand;
  input: Record<string, unknown> | undefined;
  data: Record<string, unknown> | undefined;
}): Record<string, unknown> {
  return applyResponseDataFieldTransforms({
    fields: readCommandResponseDataTransformFields(params.command),
    input: params.input ?? {},
    data: params.data,
    controlledFields: controlledResponseDataFieldNames,
  });
}

function readCommandResponseDataTransformFields(
  command: InteractionResponseDataTransformCommand,
): Record<string, ResponseDataFieldTransform> {
  const transform = resolveCommandResponseDataTransform(command);
  if (!transform) {
    throw new Error(`Missing response data transform descriptor for ${command}`);
  }
  return transform.fields;
}

function applyResponseDataFieldTransforms(params: {
  fields: Record<string, ResponseDataFieldTransform>;
  input: Record<string, unknown>;
  data: Record<string, unknown> | undefined;
  controlledFields: ReadonlySet<string>;
}): Record<string, unknown> {
  const transformed = Object.fromEntries(
    Object.entries(params.data ?? {}).filter(([key]) => !params.controlledFields.has(key)),
  );
  for (const [key, field] of Object.entries(params.fields)) {
    const value = params.input[key] === undefined ? field.defaultValue : params.input[key];
    if (value === undefined || (field.omitDefault === true && value === field.defaultValue)) {
      delete transformed[key];
      continue;
    }
    transformed[key] = value;
  }
  return Object.fromEntries(Object.entries(transformed).filter(([, value]) => value !== undefined));
}
