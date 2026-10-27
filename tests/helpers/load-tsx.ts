// Node strips TypeScript types but does not compile JSX. Test helper: bundles one .tsx entry with esbuild
// (already installed as a dependency of veryfront, no new dependency) and imports the result.
// Bare packages (react, veryfront, ...) stay external; relative imports are bundled.
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(import.meta.dirname, "..", "..");
const outDir = join(root, "node_modules", ".cache", "tsx-test");

export async function loadTsx<T = Record<string, unknown>>(entry: string): Promise<T> {
  mkdirSync(outDir, { recursive: true });
  const outfile = join(outDir, `${basename(entry).replace(/\W/g, "_")}-${process.pid}-${Date.now()}.mjs`);
  await build({
    entryPoints: [join(root, entry)],
    outfile,
    bundle: true,
    packages: "external",
    format: "esm",
    platform: "node",
    jsx: "automatic",
    logLevel: "silent",
  });
  return (await import(pathToFileURL(outfile).href)) as T;
}
