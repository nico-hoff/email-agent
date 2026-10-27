// Development hazards that break Veryfront's CSS scanner. Pure function over the filesystem, no output.
// Veryfront ignores only the project-root node_modules; agent worktrees with their own node_modules under
// .claude/worktrees push the scan past its candidate limit, which leaves the page without any styles.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const WORKTREES_DIR = [".claude", "worktrees"];

/** Relative paths (one level below .claude/worktrees, sorted) of each worktree that has a node_modules directory. */
export function findStyleScanHazards(projectRoot: string): string[] {
  const base = join(projectRoot, ...WORKTREES_DIR);
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return [];
  }
  const hits: string[] = [];
  for (const name of names) {
    try {
      if (statSync(join(base, name, "node_modules")).isDirectory()) {
        hits.push([...WORKTREES_DIR, name, "node_modules"].join("/"));
      }
    } catch {
      // Not a worktree directory, or no node_modules in it.
    }
  }
  return hits.sort();
}
