#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const copyright = "Copyright (c) 2026 Offering Discovery Protocol";
const packages = {
  agent: [
    "@apidevtools/json-schema-ref-parser",
    "@hyperjump/browser",
    "@hyperjump/json-schema",
    "@offering-protocol/core",
    "@offering-protocol/directory",
    "ajv",
    "ajv-formats",
    "http-cache-semantics"
  ],
  core: ["ajv", "ajv-formats", "bcp-47"],
  directory: ["@offering-protocol/core"],
  service: ["@offering-protocol/core"]
};
const requiredFiles = [
  "dist/index.cjs",
  "dist/index.d.ts",
  "dist/index.js",
  "LICENSE",
  "README.md"
];

async function exists(candidate) {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

async function verifyPackage(directory, expectedDependencies) {
  const packageRoot = path.join(root, "packages", directory);
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const expectedName = `@offering-protocol/${directory}`;

  if (manifest.name !== expectedName)
    throw new Error(`${directory}: expected package name ${expectedName}`);
  if (manifest.license !== "MIT") throw new Error(`${directory}: expected MIT license`);
  if (manifest.publishConfig?.access !== "public" || manifest.publishConfig?.provenance !== true) {
    throw new Error(`${directory}: public provenance publication is required`);
  }

  const dependencies = Object.keys(manifest.dependencies ?? {}).sort();
  if (JSON.stringify(dependencies) !== JSON.stringify(expectedDependencies)) {
    throw new Error(`${directory}: unexpected dependency graph`);
  }

  const license = await readFile(path.join(packageRoot, "LICENSE"), "utf8");
  if (!license.includes(copyright)) throw new Error(`${directory}: canonical copyright is missing`);

  const exportTargets = [manifest.main, manifest.module, manifest.types];
  for (const target of exportTargets) {
    if (typeof target !== "string" || !(await exists(path.join(packageRoot, target)))) {
      throw new Error(`${directory}: missing built export ${String(target)}`);
    }
  }

  const { stdout } = await execFileAsync("pnpm", ["pack", "--dry-run", "--json"], {
    cwd: packageRoot
  });
  const packed = JSON.parse(stdout);
  const record = Array.isArray(packed) ? packed[0] : packed;
  const files = new Set(record.files.map((entry) => entry.path));

  for (const required of requiredFiles) {
    if (!files.has(required)) throw new Error(`${directory}: tarball is missing ${required}`);
  }
  for (const file of files) {
    if (file.startsWith("src/") || file.startsWith("test/")) {
      throw new Error(`${directory}: tarball exposes ${file}`);
    }
  }
}

for (const [directory, dependencies] of Object.entries(packages)) {
  await verifyPackage(directory, dependencies);
}

console.log("Package publication surfaces OK");
