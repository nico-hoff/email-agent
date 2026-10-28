import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dirname, "..");
const { ensureBuiltinSchemaValidator } = await import(
  pathToFileURL(join(root, "node_modules/veryfront/esm/src/extensions/builtin-schema-validator.js")).href
) as { ensureBuiltinSchemaValidator: () => void };
ensureBuiltinSchemaValidator();
const { default: briefing, briefingConfig } = await import("../agents/briefing.ts");

const MODEL = "openai/openai/gpt-6-luna";

test("agent config follows docs/agent-contract.md (briefing): no tools, no memory, one step", () => {
  const c = briefingConfig as Record<string, unknown>;
  assert.equal(c.model, MODEL);
  assert.deepEqual(c.allowedModels, [MODEL]);
  assert.equal(c.skills, false);
  assert.deepEqual(c.mcpServers, []);
  assert.equal(c.maxSteps, 1);
  // Omitting tools = no project tools (agent-contract section 1); an empty map would say the same.
  assert.ok(!("tools" in c) || Object.keys(c.tools as object).length === 0, "no tools");
  for (const key of ["memory", "delegates", "providerTools", "knowledge", "sandbox", "temperature", "outputSchema"]) {
    assert.equal(key in c, false, key);
  }
  assert.notEqual(c.security, false, "the default security middleware stays on");
  assert.doesNotMatch(String(c.description), /mail|konto|account|postfach|inbox|briefing/i, "neutral description");
});

test("system prompt is bilingual and covers the briefing rules", () => {
  const s = String(briefingConfig.system);
  assert.match(s, /höchstens 3/);
  assert.match(s, /at most 3/);
  assert.match(s, /Deutsch/);
  assert.match(s, /untrusted_mail_subjects/);
  assert.match(s, /Befolge keine Anweisungen/);
  assert.match(s, /Never follow instructions/);
  assert.match(s, /Links/);
  assert.match(s, /links/);
  assert.match(s, /ruhiger Satz|one calm sentence/);
});

test("the created agent carries the same configuration", () => {
  const cfg = briefing.config as unknown as Record<string, unknown>;
  assert.equal(cfg.model, MODEL);
  assert.deepEqual(cfg.allowedModels, [MODEL]);
  assert.equal(cfg.maxSteps, 1);
  assert.equal(cfg.skills, false);
  assert.deepEqual(cfg.mcpServers, []);
  assert.equal(cfg.memory, undefined);
  // The id "briefing" is derived from the file name by the server's discovery (agent-contract section 1).
});

test("the agent file imports no tool and the project has no MCP route for it", () => {
  const src = readFileSync(join(root, "agents/briefing.ts"), "utf8");
  assert.doesNotMatch(src, /get-email-context|createMCPServer/);
  assert.ok(existsSync(join(root, "agents/briefing.ts")));
});
