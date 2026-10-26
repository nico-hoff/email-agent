import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };

test("every npm script that runs a local .ts file points to an existing file", () => {
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    for (const m of cmd.matchAll(/(?:^|\s)((?:scripts|tools|lib|workers)\/[\w./-]+\.ts)/g)) {
      assert.ok(existsSync(join(root, m[1])), `${name}: ${m[1]}`);
    }
  }
});

test("CLIs live in scripts/, not in the Veryfront tools folder", () => {
  for (const name of ["sample", "eval:jev"]) {
    assert.match(pkg.scripts[name], /\sscripts\/[\w-]+\.ts/, name);
  }
});

test("tools/ holds only Veryfront tool() exports", () => {
  const dir = join(root, "tools");
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    const src = readFileSync(join(dir, file), "utf8");
    assert.match(src, /from "veryfront\/tool"/, file);
    assert.match(src, /export default tool\(/, file);
  }
});
