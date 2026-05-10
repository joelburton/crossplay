/**
 * Convert one or more .puz files to .ipuz JSON.
 *
 * Run via tsx so the script can import the canonical parser/writer
 * directly from src instead of duplicating the conversion logic:
 *
 *   npx tsx packages/server/scripts/puz-to-ipuz.ts <inputs...> [--out-dir DIR]
 *
 * Each input is converted to a sibling `.ipuz` file (or written into
 * `--out-dir` if given). Existing files are NOT overwritten unless
 * `--force` is passed.
 *
 * The puzzle id is whatever the caller wants — for conversion we use
 * the input filename's stem; the value only matters if you later load
 * the file through the normal library path (which assigns its own id).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { parsePuzBuffer } from "../src/puzzle.js";
import { writeIpuz } from "../src/ipuz.js";

type Opts = { inputs: string[]; outDir?: string; force: boolean };

function parseArgs(argv: string[]): Opts {
  const inputs: string[] = [];
  let outDir: string | undefined;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    // Split `--key=value` into name + value; leave value undefined for the bare form.
    const eq = a.indexOf("=");
    const name = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    const inlineValue = a.startsWith("--") && eq > 0 ? a.slice(eq + 1) : undefined;
    if (name === "--out-dir" || name === "-o") {
      outDir = inlineValue ?? argv[++i];
      if (!outDir) throw new Error("--out-dir requires a path");
    } else if (name === "--force" || name === "-f") {
      force = true;
    } else if (name === "--help" || name === "-h") {
      process.stdout.write(
        "Usage: tsx packages/server/scripts/puz-to-ipuz.ts <inputs...> [--out-dir DIR] [--force]\n",
      );
      process.exit(0);
    } else if (a.startsWith("-")) {
      throw new Error(`unknown flag: ${a}`);
    } else {
      inputs.push(a);
    }
  }
  if (inputs.length === 0) throw new Error("no input files (pass one or more .puz paths)");
  return { inputs, outDir, force };
}

function convertOne(inputPath: string, opts: Opts): { out: string; skipped?: string } {
  const buf = readFileSync(inputPath);
  const stem = basename(inputPath, extname(inputPath));
  const { state, solution } = parsePuzBuffer(stem, buf);
  const json = writeIpuz(state, solution);
  const targetDir = opts.outDir ? resolve(opts.outDir) : dirname(resolve(inputPath));
  if (opts.outDir) mkdirSync(targetDir, { recursive: true });
  const outPath = resolve(targetDir, `${stem}.ipuz`);
  if (existsSync(outPath) && !opts.force) {
    return { out: outPath, skipped: "exists (use --force to overwrite)" };
  }
  writeFileSync(outPath, json);
  return { out: outPath };
}

const opts = parseArgs(process.argv.slice(2));
let failures = 0;
for (const input of opts.inputs) {
  try {
    const { out, skipped } = convertOne(input, opts);
    if (skipped) {
      process.stdout.write(`SKIP  ${input} -> ${out}  (${skipped})\n`);
    } else {
      process.stdout.write(`WROTE ${input} -> ${out}\n`);
    }
  } catch (err) {
    failures++;
    process.stderr.write(`FAIL  ${input}: ${(err as Error).message}\n`);
  }
}
process.exit(failures > 0 ? 1 : 0);
