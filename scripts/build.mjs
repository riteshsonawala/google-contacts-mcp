#!/usr/bin/env node
/**
 * Build script that strips TypeScript type annotations from src/google-contacts-mcp.ts
 * using Node's built-in `node:module.stripTypeScriptTypes` and emits a clean, standalone,
 * zero-dependency `google-contacts-mcp.mjs` executable.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcPath = path.join(rootDir, "src", "google-contacts-mcp.ts");
const outPath = path.join(rootDir, "google-contacts-mcp.mjs");

const tsSource = fs.readFileSync(srcPath, "utf8");
const rawJs = stripTypeScriptTypes(tsSource, { mode: "strip" });

// Clean up whitespace left by type-stripping while keeping formatting readable
const cleanedJs = rawJs
  .split("\n")
  .map((line) => line.replace(/[ \t]+$/, ""))
  .join("\n")
  .replace(/\n{3,}/g, "\n\n");

fs.writeFileSync(outPath, cleanedJs, { encoding: "utf8", mode: 0o755 });
fs.chmodSync(outPath, 0o755);
console.log(`Built standalone ${outPath} (${Buffer.byteLength(cleanedJs)} bytes)`);
