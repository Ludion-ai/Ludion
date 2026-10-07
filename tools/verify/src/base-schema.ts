// Compile the lesson schema at run time, for CI. verify:pr reads the schema from the base branch,
// so a PR cannot loosen the rules it is checked against. Node only (Ajv generates code).
import { Ajv2020 } from "ajv/dist/2020.js";
import { lessonValidator, type LessonValidator, type ValidateFn } from "@ludion/core";

export function compileLessonSchema(schemaJson: string): LessonValidator {
  // Same options as packages/core/scripts/validator-source.ts.
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return lessonValidator(ajv.compile(JSON.parse(schemaJson)) as unknown as ValidateFn);
}
