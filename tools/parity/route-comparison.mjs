#!/usr/bin/env node

/**
 * Route comparison (P12.3).
 *
 * OrcaXR slices two ways: the WASM engine in the browser, and the external
 * OrcaSlicer CLI behind the server. Both are built from the same pinned fork,
 * and P12.3 names a route-comparison corpus because "the same source" is not
 * the same as "the same output" — different build flags, different threading,
 * a patch applied to one tree and not the other, and the two quietly disagree.
 * Nothing else in this repository would notice.
 *
 * The comparison is **semantic, not byte-exact**, because byte equality is the
 * wrong bar: the two builds legitimately differ in their comment headers,
 * timings, and generator strings. What must agree is what the printer does —
 * how many layers, how much filament, which extrusion roles appear, and which
 * printer commands are emitted.
 *
 * This refuses to run without the external CLI rather than skipping. A
 * qualification step that quietly passes when it could not test anything is
 * how a divergence ships; if the CLI is absent, the qualifier is in the wrong
 * environment and should be told so.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Semantic facts a program states about what the printer will do. */
export function summariseProgram(gcode) {
  const filament = /^; filament used \[mm\] = ([\d.]+)/m.exec(gcode);
  const roles = new Set();
  for (const match of gcode.matchAll(/^;TYPE:(.+)$/gm)) roles.add(match[1].trim());
  const commands = new Set();
  for (const match of gcode.matchAll(/^(M\d+|G\d+|SET_[A-Z_]+)\b/gm)) commands.add(match[1]);
  return {
    layers: (gcode.match(/^;LAYER_CHANGE$/gm) ?? []).length,
    filamentMm: filament ? Number.parseFloat(filament[1]) : null,
    roles: [...roles].sort(),
    commands: [...commands].sort(),
    extrudingMoves: (gcode.match(/^G1 (?=[^\n]*\sE-?[\d.]+)/gm) ?? []).length,
  };
}

/**
 * Compare two summaries, with tolerances that reflect what actually matters.
 *
 * Filament is compared proportionally because the two builds round differently
 * over thousands of moves; an absolute millimetre threshold would either pass a
 * real divergence on a large print or fail a rounding difference on a small
 * one. Layers, roles and commands are compared exactly — a missing extrusion
 * role or a dropped `M104` is never a tolerance question.
 */
export function compareSummaries(left, right, { filamentTolerance = 0.01 } = {}) {
  const differences = [];
  if (left.layers !== right.layers) {
    differences.push(`layer count: ${left.layers} vs ${right.layers}`);
  }
  if (left.filamentMm === null || right.filamentMm === null) {
    differences.push('one route did not report a filament total');
  } else {
    const relative = Math.abs(left.filamentMm - right.filamentMm) / Math.max(left.filamentMm, 1);
    if (relative > filamentTolerance) {
      differences.push(
        `filament: ${left.filamentMm} vs ${right.filamentMm} mm (${(relative * 100).toFixed(2)}% apart)`,
      );
    }
  }
  for (const [name, key] of [
    ['extrusion role', 'roles'],
    ['command', 'commands'],
  ]) {
    const onlyLeft = left[key].filter((value) => !right[key].includes(value));
    const onlyRight = right[key].filter((value) => !left[key].includes(value));
    if (onlyLeft.length > 0) differences.push(`${name}s only in the first route: ${onlyLeft.join(', ')}`);
    if (onlyRight.length > 0) differences.push(`${name}s only in the second route: ${onlyRight.join(', ')}`);
  }
  return differences;
}

/** Slice through the external CLI, or say why it could not be reached. */
export function sliceWithCli(archivePath, cliPath) {
  if (!existsSync(cliPath)) {
    throw new Error(
      `The external OrcaSlicer CLI is not at ${cliPath}. Route comparison needs both engines; ` +
        'set ORCAXR_CLI to the qualification build rather than skipping this corpus.',
    );
  }
  const outputDir = mkdtempSync(join(tmpdir(), 'orcaxr-route-'));
  const output = join(outputDir, 'route.gcode');
  execFileSync(cliPath, ['--export-gcode', '--outputdir', outputDir, archivePath], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    // The pinned fork refuses newer project files without this, and the server
    // sets the same flag; a comparison run under different rules would be
    // comparing two different behaviours rather than two builds.
    env: { ...process.env, SNAPMAKER_ORCA_ALLOW_NEWER_FILE: '1' },
  });
  if (!existsSync(output)) {
    const produced = execFileSync('ls', [outputDir], { encoding: 'utf8' }).trim().split('\n')[0];
    if (!produced) throw new Error('The external CLI produced no G-code');
    return readFileSync(join(outputDir, produced), 'utf8');
  }
  return readFileSync(output, 'utf8');
}

export function main(argv = process.argv.slice(2)) {
  const archive = argv[0];
  const cliPath = process.env.ORCAXR_CLI ?? '/app/orca/orca-slicer';
  if (!archive) throw new Error('Usage: route-comparison.mjs <project.3mf>  (ORCAXR_CLI must point at the CLI)');
  const wasmGcode = readFileSync(`${archive}.wasm.gcode`, 'utf8');
  const cliGcode = sliceWithCli(resolve(archive), cliPath);
  const differences = compareSummaries(summariseProgram(wasmGcode), summariseProgram(cliGcode));
  if (differences.length > 0) {
    for (const difference of differences) console.error(`  ✗ ${difference}`);
    throw new Error(`The two routes disagree in ${differences.length} way(s)`);
  }
  console.log('Route comparison: the WASM and CLI routes agree on layers, filament, roles and commands.');
  return differences;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(`parity route-comparison: ${error.message}`);
    process.exitCode = 1;
  }
}
