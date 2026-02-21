import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const SOURCE_PATH = path.join(ROOT, "docs", "openapi.yaml");
const TARGET_PATH = path.join(ROOT, "src", "openapi.ts");

function buildTargetContent(yaml) {
  return [
    "// Synchronized from docs/openapi.yaml for runtime API docs.",
    "// Do not edit manually. Run `npm run openapi:sync` after updating docs/openapi.yaml.",
    `export const OPENAPI_YAML = ${JSON.stringify(yaml)};`,
    ""
  ].join("\n");
}

function main() {
  const checkOnly = process.argv.includes("--check");
  const yaml = fs.readFileSync(SOURCE_PATH, "utf8");
  const next = buildTargetContent(yaml);
  const current = fs.existsSync(TARGET_PATH) ? fs.readFileSync(TARGET_PATH, "utf8") : "";

  if (current === next) {
    console.log("OpenAPI runtime spec is in sync.");
    return;
  }

  if (checkOnly) {
    console.error("OpenAPI runtime spec is out of sync. Run: npm run openapi:sync");
    process.exit(1);
  }

  fs.writeFileSync(TARGET_PATH, next, "utf8");
  console.log("Synchronized docs/openapi.yaml -> src/openapi.ts");
}

main();
