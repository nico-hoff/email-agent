import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findStyleScanHazards } from "../lib/dev-hazards.ts";
import { createService } from "../server.ts";

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "dev-hazards-"));
}

function worktree(root: string, name: string, withModules: boolean): void {
  const dir = join(root, ".claude", "worktrees", name);
  mkdirSync(dir, { recursive: true });
  if (withModules) mkdirSync(join(dir, "node_modules"));
}

describe("findStyleScanHazards", () => {
  it("returns an empty list when there is no .claude/worktrees directory", () => {
    const root = makeProject();
    try {
      assert.deepEqual(findStyleScanHazards(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores a worktree without node_modules", () => {
    const root = makeProject();
    try {
      worktree(root, "clean", false);
      assert.deepEqual(findStyleScanHazards(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns the sorted relative node_modules paths, one level deep only", () => {
    const root = makeProject();
    try {
      worktree(root, "zeta", true);
      worktree(root, "alpha", true);
      worktree(root, "clean", false);
      // Deeper node_modules are not part of the scan root and must not be reported.
      mkdirSync(join(root, ".claude", "worktrees", "clean", "pkg", "node_modules"), { recursive: true });
      assert.deepEqual(findStyleScanHazards(root), [
        ".claude/worktrees/alpha/node_modules",
        ".claude/worktrees/zeta/node_modules",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns an empty list when the worktrees directory cannot be read", () => {
    const root = makeProject();
    try {
      // A regular file where the directory should be makes readdir fail for any user, including root.
      mkdirSync(join(root, ".claude"), { recursive: true });
      writeFileSync(join(root, ".claude", "worktrees"), "not a directory");
      assert.deepEqual(findStyleScanHazards(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function harness(projectRoot: string) {
  const logs: string[] = [];
  return {
    logs,
    options: {
      port: 0,
      bindAddress: "127.0.0.1",
      env: {},
      projectRoot,
      log: (m: string) => logs.push(m),
      onSignal: () => undefined,
      startup: () => ({ db: { close() {} }, config: { status: "disabled" } }) as never,
      startHttp: async () => ({
        port: 4321,
        url: "http://127.0.0.1:4321",
        stop: async () => undefined,
      }),
    },
  };
}

const WARNING_PREFIX = "warning: 1 agent worktree(s) with node_modules under .claude/worktrees break Veryfront styles";

describe("createService style-scan warning", () => {
  it("logs the warning once in development mode", async () => {
    const root = makeProject();
    try {
      worktree(root, "agent-x", true);
      const h = harness(root);
      const svc = await createService({ ...h.options, mode: "development" } as never);
      const warnings = h.logs.filter((l) => l.startsWith("warning: "));
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0]!.startsWith(WARNING_PREFIX), warnings[0]);
      assert.ok(warnings[0]!.endsWith("remove them with git worktree remove after checking for unsaved work"));
      assert.ok(!warnings[0]!.includes(root), "warning must not print absolute paths");
      await svc.stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not log the warning in production mode", async () => {
    const root = makeProject();
    try {
      worktree(root, "agent-x", true);
      const h = harness(root);
      const svc = await createService({ ...h.options, mode: "production" } as never);
      assert.equal(h.logs.filter((l) => l.startsWith("warning: ")).length, 0);
      await svc.stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
