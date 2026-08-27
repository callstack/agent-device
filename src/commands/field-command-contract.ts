import { defineCommandMetadata, type CommandMetadata } from './command-contract.ts';
import {
  fieldAudiences,
  fieldsInputSchema,
  readFieldInput,
  type CommandFieldMap,
  type InferCommandInput,
} from './command-input.ts';

type FieldCommandOptions<TInput> = {
  /** For a command that reads its own fields (`batch` validates steps, `gesture` reads a union). */
  readInput: (input: unknown) => TInput;
};

/**
 * The one construction path for a command whose input is a field map. It is the
 * only place `fieldsInputSchema` and `fieldAudiences` are called, so a field
 * declaring `operatorField(...)` or `retiredField(...)` cannot reach a command
 * whose metadata forgot to carry that audience to the surface boundaries.
 */
export function defineFieldCommandMetadata<
  const TName extends string,
  const TFields extends CommandFieldMap,
>(
  name: TName,
  description: string,
  fields: TFields,
): CommandMetadata<TName, InferCommandInput<TFields>>;
export function defineFieldCommandMetadata<const TName extends string, TInput>(
  name: TName,
  description: string,
  fields: CommandFieldMap,
  options: FieldCommandOptions<TInput>,
): CommandMetadata<TName, TInput>;
export function defineFieldCommandMetadata(
  name: string,
  description: string,
  fields: CommandFieldMap,
  options?: FieldCommandOptions<unknown>,
): CommandMetadata<string, unknown> {
  return defineCommandMetadata({
    name,
    description,
    inputSchema: fieldsInputSchema(fields),
    readInput: options?.readInput ?? ((input) => readFieldInput(input, fields)),
    inputAudience: fieldAudiences(fields),
  });
}
