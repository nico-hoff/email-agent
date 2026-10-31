import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("Node version is identical in .nvmrc, engines.node and Dockerfile", () => {
  const nvmrc = read(".nvmrc").trim();
  const engines = JSON.parse(read("package.json")).engines.node;
  const from = /^FROM node:([^\s-]+)-slim(?: AS \w+)?\s*$/m.exec(read("Dockerfile"))?.[1];
  assert.equal(nvmrc, "26.12.1");
  assert.equal(engines, nvmrc);
  assert.equal(from, nvmrc);
});

test("CI reads the Node version from .nvmrc", () => {
  assert.match(read(".github/workflows/ci.yml"), /node-version-file:\s*\.nvmrc/);
});
