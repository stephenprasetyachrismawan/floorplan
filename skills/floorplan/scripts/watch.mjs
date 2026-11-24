#!/usr/bin/env node
// Keeps a project's map current on its own, and optionally serves it: made to run as a login service, so the map
// at http://127.0.0.1:<port> is always up to date with the code.
//
// Every few seconds it fingerprints the project's files (git's list, sizes and modification times: cheap). When
// that changes and then holds still, it updates only what the change touches:
//   1. graphify: graphify-sync.mjs re-extracts just the changed files into graphify-out/graph.json;
//   2. scan.mjs: reads just the changed files (the rest come from its per-file cache) and re-joins everything;
//   3. odoo-arch.mjs --update: a new Odoo addon gets its part (your edits to architecture.json stay);
//   4. build.mjs: redraws graph.json and index.html; open tabs reload themselves.
// Once a day (--full-at, default 03:30) it runs the full `graphify update`, which re-clusters communities.
//
// usage: node watch.mjs [root] [--serve] [--port 4378] [--interval 5] [--full-at 03:30|off] [--no-graphify] [--once]

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, mapDir } from './lib/common.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args._[0] || '.');
const outDir = mapDir(root);
const interval = Math.max(2, Number(args.interval) || 5) * 1000;
const fullAt = args['full-at'] === 'off' ? null : /^\d{1,2}:\d{2}$/.test(String(args['full-at'] || '')) ? String(args['full-at']) : '03:30';
const useGraphify = !args['no-graphify'];
const node = process.execPath;
const stamp = () => { const d = new Date(); const z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`; };
const log = (msg) => console.log(`${stamp()}  ${msg}`);
const OWN = /^(floorplan|graphify-out|\.floww|node_modules)\//;

/** A fingerprint of the checkout: HEAD plus every listed file's size and modification time. */
function fingerprint() {
  const h = createHash('sha1');
  try { h.update(execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { /* not a git repo */ }
  let list = [];
  try { list = execFileSync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0'); } catch { /* git unavailable: nothing to compare */ }
  for (const p of list) {
    if (!p || OWN.test(p)) continue;
    try { const st = fs.statSync(path.join(root, p)); h.update(`${p}\0${st.size}\0${st.mtimeMs}\n`); } catch { h.update(`${p}\0gone\n`); }
  }
  return h.digest('hex');
}

function step(label, script, extra = []) {
  const t = performance.now();
  try {
    execFileSync(node, [path.join(HERE, script), root, ...extra], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return `${label} ${((performance.now() - t) / 1000).toFixed(1)}s`;
  } catch (e) {
    const said = String(e.stdout || '').split('\n').concat(String(e.stderr || '').split('\n')).filter((l) => /✗|error|Error/.test(l)).slice(0, 4).join(' | ');
    throw new Error(`${label} failed: ${said || e.message}`);
  }
}

let running = false;
function update(reason, { full = false } = {}) {
  if (running) return false;
  running = true;
  const t = performance.now(); // monotonic: WSL's clock can jump while a step runs
  const done = [];
  try {
    if (useGraphify && fs.existsSync(path.join(root, 'graphify-out', 'graph.json'))) {
      try { done.push(step(full ? 'graphify(full)' : 'graphify', 'graphify-sync.mjs', full ? ['--full'] : [])); } catch (e) { log(`! ${e.message} (the map is still built from the code)`); }
    }
    done.push(step('scan', 'scan.mjs'));
    const scanFile = path.join(outDir, '.cache', 'scan.json');
    const isOdoo = (() => { try { return !!JSON.parse(fs.readFileSync(scanFile, 'utf8')).odoo?.modules?.length; } catch { return false; } })();
    if (isOdoo) done.push(step('odoo-arch', 'odoo-arch.mjs', fs.existsSync(path.join(outDir, 'architecture.json')) ? ['--update'] : []));
    if (!fs.existsSync(path.join(outDir, 'architecture.json'))) { log('no floorplan/architecture.json yet: make the map once with the floorplan skill (or odoo-arch.mjs for Odoo)'); return true; }
    done.push(step('build', 'build.mjs', ['--no-claude-md']));
    const secs = (performance.now() - t) / 1000;
    log(`updated (${reason}) in ${secs.toFixed(1)}s: ${done.join(', ')}`);
    try { fs.writeFileSync(path.join(outDir, '.cache', 'watch.json'), JSON.stringify({ at: new Date().toISOString(), reason, seconds: secs, steps: done })); } catch { /* the map folder is gone */ }
  } catch (e) {
    log(`! update failed: ${e.message}`);
  } finally { running = false; }
  return true;
}

// ---------- serve ----------
let server = null;
function serve() {
  const script = path.join(outDir, 'serve.mjs');
  if (!fs.existsSync(script)) { log('no floorplan/serve.mjs yet (build first); retrying in 30s'); setTimeout(serve, 30000); return; }
  const port = String(Number(args.port) || 4378);
  server = spawn(node, [script, '--port', port, '--no-open'], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, FLOORPLAN_NO_PROMPTS: '1' } });
  log(`serving the map at http://127.0.0.1:${port}/`);
  server.on('exit', (code) => { server = null; log(`map server stopped (${code}); restarting in 5s`); setTimeout(serve, 5000); });
}
const stop = () => { if (server) { server.removeAllListeners('exit'); server.kill(); } process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

// ---------- loop ----------
// serve the map as it is right away, then bring it up to date
if (args.serve && !args.once) serve();
update('start');
if (args.once) process.exit(0);
let last = fingerprint(), pending = null, lastFull = null;
setInterval(() => {
  const now = fingerprint();
  if (now !== last) { pending = now; last = now; return; } // changed: wait until it holds still for one more tick
  if (pending && pending === now) { pending = null; update('code changed'); }
  if (fullAt) {
    const d = new Date();
    const today = d.toISOString().slice(0, 10);
    const [hh, mm] = fullAt.split(':').map(Number);
    if (lastFull !== today && (d.getHours() > hh || (d.getHours() === hh && d.getMinutes() >= mm)) && d.getHours() < hh + 2) {
      lastFull = today;
      if (update('nightly full graphify', { full: true })) last = fingerprint();
    }
  }
}, interval);
log(`watching ${root} every ${interval / 1000}s${fullAt ? `, full graphify update daily at ${fullAt}` : ''}`);
