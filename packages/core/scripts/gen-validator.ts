// Compiles lessons/lessons.schema.json into a standalone validator module.
// Workers forbid runtime code generation (new Function), so Ajv runs here, at build time.
// Run: npm run gen:validator. A unit test fails if the committed file is stale.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateValidatorSource } from "./validator-source.ts";

const schemaPath = fileURLToPath(new URL("../../../lessons/lessons.schema.json", import.meta.url));
const outPath = fileURLToPath(new URL("../src/generated/validate-lesson.js", import.meta.url));

writeFileSync(outPath, generateValidatorSource(readFileSync(schemaPath, "utf8")));
console.log(`Wrote ${outPath}`);
