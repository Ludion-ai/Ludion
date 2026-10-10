// Compiles the lesson schemas into standalone validator modules: lessons/lessons.schema.json (format 1) and the
// frozen lessons/lessons-v0.schema.json (format 0). Workers forbid runtime code generation (new Function), so Ajv
// runs here, at build time. Run: npm run gen:validator. A unit test fails if a committed file is stale.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateValidatorSource } from "./validator-source.ts";

export const VALIDATORS = [
  { schema: "lessons.schema.json", out: "validate-lesson.js" },
  { schema: "lessons-v0.schema.json", out: "validate-lesson-v0.js" },
] as const;

if (import.meta.main) {
  for (const { schema, out } of VALIDATORS) {
    const schemaPath = fileURLToPath(new URL(`../../../lessons/${schema}`, import.meta.url));
    const outPath = fileURLToPath(new URL(`../src/generated/${out}`, import.meta.url));
    writeFileSync(outPath, generateValidatorSource(readFileSync(schemaPath, "utf8"), schema));
    console.log(`Wrote ${outPath}`);
  }
}
