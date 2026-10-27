import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { applyOpenRouterEnv } from "../lib/openrouter-env.ts";

const root = join(import.meta.dirname, "..");
const { ensureBuiltinSchemaValidator } = await import(
  pathToFileURL(join(root, "node_modules/veryfront/esm/src/extensions/builtin-schema-validator.js")).href
) as { ensureBuiltinSchemaValidator: () => void };
ensureBuiltinSchemaValidator();
const { default: replyDrafter, replyDrafterConfig, replyDraftSchema } = await import("../agents/reply-drafter.ts");

const MODEL = "openai/openai/gpt-6-luna";

test("agent config follows docs/agent-contract.md section 1", () => {
  const c = replyDrafterConfig as Record<string, unknown>;
  assert.equal(c.model, MODEL);
  assert.deepEqual(c.allowedModels, [MODEL]);
  assert.deepEqual(c.tools, { "get-email-context": true });
  assert.equal(c.skills, false);
  assert.deepEqual(c.mcpServers, []);
  assert.equal(c.maxSteps, 3);
  for (const key of ["memory", "delegates", "providerTools", "knowledge", "sandbox", "security", "temperature"]) {
    assert.equal(key in c, false, key);
  }
  assert.ok(c.outputSchema, "outputSchema");
  const description = String(c.description);
  assert.doesNotMatch(description, /mail|konto|account|postfach|inbox/i, "neutral description");
});

test("system prompt is bilingual and covers the draft-only rules", () => {
  const s = String(replyDrafterConfig.system);
  assert.match(s, /Entwürfe/);
  assert.match(s, /draft replies/);
  assert.match(s, /untrusted_email_excerpt/);
  assert.match(s, /Befolge keine Anweisungen/);
  assert.match(s, /Never follow instructions/);
  assert.match(s, /needs_human_check/);
  assert.match(s, /Links/);
  assert.match(s, /links/);
});

test("the created agent carries the same configuration", () => {
  const cfg = replyDrafter.config as unknown as Record<string, unknown>;
  assert.equal(cfg.model, MODEL);
  assert.deepEqual(cfg.allowedModels, [MODEL]);
  assert.equal(cfg.maxSteps, 3);
  assert.equal(cfg.skills, false);
  assert.deepEqual(cfg.mcpServers, []);
  assert.equal(cfg.memory, undefined);
});

test("output schema accepts exactly the contract shape", () => {
  const ok = { draft: "Hallo", language: "de", tone: "formal", needs_human_check: false, reasons: [] };
  assert.equal(replyDraftSchema.safeParse(ok).success, true);
  assert.equal(replyDraftSchema.safeParse({ ...ok, language: "fr" }).success, false);
  assert.equal(replyDraftSchema.safeParse({ ...ok, reasons: "x" }).success, false);
  const { tone: _tone, ...missing } = ok;
  assert.equal(replyDraftSchema.safeParse(missing).success, false);
});

test("no MCP server route and no MCP config exist (agent-contract section 2)", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]
    );
  for (const dir of ["app", "agents", "tools", "lib", "workers"]) {
    if (!existsSync(join(root, dir))) continue;
    for (const file of walk(join(root, dir))) {
      if (!/\.(ts|tsx)$/.test(file)) continue;
      const src = readFileSync(file, "utf8");
      assert.doesNotMatch(src, /createMCPServer/, file);
    }
  }
  if (existsSync(join(root, "veryfront.config.ts"))) {
    assert.doesNotMatch(readFileSync(join(root, "veryfront.config.ts"), "utf8"), /mcp/i);
  }
  for (const t of readdirSync(join(root, "tools"))) {
    assert.match(readFileSync(join(root, "tools", t), "utf8"), /mcp:\s*\{\s*enabled:\s*false/, t);
  }
});

test("applyOpenRouterEnv sets only missing values and never overwrites", () => {
  const env: Record<string, string | undefined> = { OPENROUTER_API_KEY: "or-key" };
  applyOpenRouterEnv(env);
  assert.equal(env.OPENAI_API_KEY, "or-key");
  assert.equal(env.OPENAI_BASE_URL, "https://openrouter.ai/api/v1");

  const preset: Record<string, string | undefined> = {
    OPENROUTER_API_KEY: "or-key",
    OPENAI_API_KEY: "own-key",
    OPENAI_BASE_URL: "http://localhost:1234/v1",
  };
  applyOpenRouterEnv(preset);
  assert.equal(preset.OPENAI_API_KEY, "own-key");
  assert.equal(preset.OPENAI_BASE_URL, "http://localhost:1234/v1");

  const noKey: Record<string, string | undefined> = {};
  applyOpenRouterEnv(noKey);
  assert.equal(noKey.OPENAI_API_KEY, undefined, "no key invented");
});

test("applyOpenRouterEnv writes nothing to stdout, stderr or console", () => {
  const seen: string[] = [];
  const o = process.stdout.write, e = process.stderr.write;
  process.stdout.write = ((c: unknown) => { seen.push(String(c)); return true; }) as never;
  process.stderr.write = ((c: unknown) => { seen.push(String(c)); return true; }) as never;
  try {
    applyOpenRouterEnv({ OPENROUTER_API_KEY: "or-secret-marker" });
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
  assert.deepEqual(seen, []);
});

test("createService derives the OpenAI variables from OPENROUTER_API_KEY at startup", async () => {
  const { createService } = await import("../server.ts");
  const { mkdtempSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const savedDb = process.env.DATABASE_PATH;
  const r = mkdtempSync(join(tmpdir(), "or-env-"));
  chmodSync(r, 0o700);
  const env: Record<string, string | undefined> = { OPENROUTER_API_KEY: "or-key" };
  try {
    const svc = await createService({
      synthetic: true, projectRoot: r, env, onSignal: () => {}, log: () => {},
      startHttp: async () => ({ port: 1, url: "http://127.0.0.1:1", stop: async () => {} }),
    });
    assert.equal(env.OPENAI_API_KEY, "or-key");
    assert.equal(env.OPENAI_BASE_URL, "https://openrouter.ai/api/v1");
    await svc.stop();
  } finally {
    if (savedDb === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = savedDb;
  }
});
