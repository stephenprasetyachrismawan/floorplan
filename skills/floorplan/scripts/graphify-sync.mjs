#!/usr/bin/env node
// Brings graphify-out/graph.json up to date by re-extracting only the code files that changed since the last sync
// (scripts/lib/graphify_sync.py, run with graphify's own Python). On a large repo that's seconds instead of the
// minutes `graphify update .` takes, with the same nodes and edges. --full runs `graphify update . --force`, which
// also re-clusters communities and rewrites GRAPH_REPORT.md.
//
// usage: node graphify-sync.mjs [root] [--full] [--json] [--dry-run]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/common.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args._[0] || '.');

/** graphify's Python: the one graphify recorded for this project, else its usual pipx install. */
export function graphifyPython(dir) {
  const candidates = [];
  try { candidates.push(fs.readFileSync(path.join(dir, 'graphify-out', '.graphify_python'), 'utf8').trim()); } catch { /* graphify never ran here */ }
  candidates.push(path.join(os.homedir(), '.local', 'share', 'pipx', 'venvs', 'graphifyy', 'bin', 'python'));
  return candidates.find((p) => p && path.isAbsolute(p) && fs.existsSync(p)) || null;
}

if (import.meta.url === `file://${process.argv[1]}` || fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '')) {
  const py = graphifyPython(root);
  if (!py) { console.error('✗ graphify is not installed (no graphify-out/.graphify_python and no pipx graphifyy). Install graphify first.'); process.exit(1); }
  const flags = ['full', 'json', 'dry-run'].filter((f) => args[f]).map((f) => `--${f}`);
  try {
    execFileSync(py, ['-I', path.join(HERE, 'lib', 'graphify_sync.py'), root, ...flags], { stdio: 'inherit', cwd: root });
  } catch (e) { process.exit(e.status || 1); }
}
