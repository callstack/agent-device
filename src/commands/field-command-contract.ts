import { defineCommandMetadata } from './command-contract.ts';
import {
  fieldsInputSchema,
  readFieldInput,
  retiredFieldNames,
  type CommandFieldMap,
} from './command-input.ts';

export function defineFieldCommandMetadata<
  const TName extends string,
  const TFields extends CommandFieldMap,
>(name: TName, description: string, fields: TFields) {
  return defineCommandMetadata({
    name,
    description,
    inputSchema: fieldsInputSchema(fields),
    readInput: (input) => readFieldInput(input, fields),
    retiredInputKeys: retiredFieldNames(fields),
  });
}
