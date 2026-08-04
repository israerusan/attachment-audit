// Test runner. Bundles every test/*.test.ts (aliasing `obsidian` to a Node-safe
// stub so the real src/ code runs unchanged), executes them, then runs the plain
// .mjs contract/license tests.
//
// Every file runs even when an earlier one fails, and a tally is printed at the
// end: aborting on the first assertion hid whether the other seventeen files were
// also broken, which is exactly the information you need while fixing one.
//
// Usage: `node test/run.mjs [filter]` — the optional filter is a substring match
// on the filename, e.g. `node test/run.mjs pathRewrite`.
import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(root, "test");
const buildDir = path.join(testDir, ".build");
fs.mkdirSync(buildDir, { recursive: true });

const filter = process.argv[2] ?? "";
const matches = (file) => !filter || file.toLowerCase().includes(filter.toLowerCase());

const passed = [];
const failed = [];

async function record(file, run) {
  try {
    await run();
    passed.push(file);
    console.log(`  ok    ${file}`);
  } catch (err) {
    failed.push({ file, err });
    console.error(`  FAIL  ${file}`);
    console.error(String(err?.stack ?? err).replace(/^/gm, "        "));
  }
}

const tsTests = fs
  .readdirSync(testDir)
  .filter((f) => f.endsWith(".test.ts") && matches(f))
  .sort();

for (const file of tsTests) {
  const outfile = path.join(buildDir, file.replace(/\.ts$/, ".cjs"));
  await record(file, async () => {
    await esbuild.build({
      entryPoints: [path.join(testDir, file)],
      bundle: true,
      outfile,
      format: "cjs",
      platform: "node",
      target: "node18",
      logLevel: "warning",
      alias: {
        obsidian: path.join(testDir, "obsidian-stub.ts"),
      },
    });
    await import(pathToFileURL(outfile).href);
  });
}

const mjsTests = fs
  .readdirSync(testDir)
  .filter((f) => f.endsWith(".test.mjs") && matches(f))
  .sort();

for (const file of mjsTests) {
  await record(file, () => import(pathToFileURL(path.join(testDir, file)).href));
}

const total = passed.length + failed.length;
if (total === 0) {
  console.error(`\nNo test files matched "${filter}".`);
  process.exitCode = 1;
} else if (failed.length > 0) {
  console.error(`\n${failed.length} of ${total} test files FAILED:`);
  for (const { file } of failed) console.error(`  - ${file}`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${total} test files passed.`);
}
