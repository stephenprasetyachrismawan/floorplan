// Updates that touch only what changed: the scan's per-file cache, graphify's graph lifted into the map (and cached
// per graph.json), and graphify-sync re-extracting only changed files (when graphify is installed).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeProject, run, readJson, readGraph, writeJson, cleanup, SKILL } from './helpers.mjs';

const root = makeProject({
  'api/app.py': 'from flask import Flask\nfrom api.orders import list_orders\napp = Flask(__name__)\n\n@app.route("/orders")\ndef orders():\n    return list_orders()\n',
  'api/__init__.py': '',
  'api/orders.py': 'def list_orders():\n    """All orders."""\n    return []\n',
  'web/main.js': "export const load = () => fetch('/orders');\n",
}, { repos: ['.'], arch: { project: { name: 'Shop' }, nodes: [{ id: 'api', label: 'API', kind: 'service', summary: 'x', paths: ['api'] }, { id: 'web', label: 'Web', kind: 'ui', summary: 'y', paths: ['web'] }] } });
after(() => cleanup(root));
const scanOf = () => readJson(path.join(root, 'floorplan', '.cache', 'scan.json'));
const strip = (s) => ({ ...s, generatedAt: null });

test('a second scan reads only the files that changed, and gives the same result as a scan without the cache', () => {
  assert.match(run('scan.mjs', root), /4 file\(s\) read, 0 unchanged/);
  assert.match(run('scan.mjs', root), /0 file\(s\) read, 4 unchanged/);
  fs.writeFileSync(path.join(root, 'api/orders.py'), 'def list_orders():\n    """All orders."""\n    return []\n\ndef cancel_order(i):\n    return i\n');
  assert.match(run('scan.mjs', root), /1 file\(s\) read, 3 unchanged/);
  const cached = strip(scanOf());
  run('scan.mjs', root, '--no-cache');
  assert.deepEqual(cached, strip(scanOf()));
  assert.ok(cached.files.find((f) => f.path === 'api/orders.py').symbols.some((s) => s.name === 'cancel_order'));
  // the resolved targets later steps add to imports don't leak into the cache
  run('scan.mjs', root);
  assert.deepEqual(strip(scanOf()).edges, cached.edges);
});

test('graphify-out/graph.json: cross-file calls and communities are drawn, and lifted once per graph change', () => {
  const g = {
    directed: false, multigraph: false, graph: {}, built_at_commit: 'abc1234',
    nodes: [
      { id: 'app_orders', label: 'orders()', file_type: 'code', source_file: 'api/app.py', community: 1 },
      { id: 'orders_list', label: 'list_orders()', file_type: 'code', source_file: 'api/orders.py', community: 1 },
      { id: 'web_load', label: 'load()', file_type: 'code', source_file: 'web/main.js', community: 2 },
      { id: 'gone', label: 'x()', file_type: 'code', source_file: 'old/deleted.py', community: 2 },
    ],
    links: [
      { source: 'app_orders', target: 'orders_list', relation: 'calls' },
      { source: 'web_load', target: 'gone', relation: 'calls' },
      { source: 'app_orders', target: 'orders_list', relation: 'method' },
    ],
  };
  writeJson(path.join(root, 'graphify-out', 'graph.json'), g);
  writeJson(path.join(root, 'graphify-out', '.graphify_labels.json'), { 1: 'Orders API', 2: 'Web' });
  run('scan.mjs', root);
  const out = run('build.mjs', root, '--no-claude-md');
  assert.match(out, /GRAPHIFY {2}1 file links/);
  const graph = readGraph(root);
  assert.ok(graph.links.some((l) => l.a === 'f:api/app.py' && l.b === 'f:api/orders.py' && l.k === 'call'));
  assert.equal(graph.files.find((f) => f.p === 'api/orders.py').g, 'Orders API #1');
  assert.equal(graph.meta.graphify.commit, 'abc1234');
  // the second build reads the lifted cache, not graph.json
  const cache = readJson(path.join(root, 'floorplan', '.cache', 'graphify.json'));
  assert.equal(cache.links.length, 2);
  fs.writeFileSync(path.join(root, 'graphify-out', 'graph.json'), '{ not json'); // would fail if it were read again
  const st = fs.statSync(path.join(root, 'graphify-out', 'graph.json'));
  writeJson(path.join(root, 'floorplan', '.cache', 'graphify.json'), { ...cache, stamp: `${st.size}:${Math.round(st.mtimeMs)}` }); // as if lifted from this file
  assert.match(run('build.mjs', root, '--no-claude-md'), /GRAPHIFY {2}1 file links/);
});

// graphify-sync needs graphify itself: run where it's installed, skip elsewhere
const graphifyPy = path.join(process.env.HOME || '', '.local', 'share', 'pipx', 'venvs', 'graphifyy', 'bin', 'python');
test('graphify-sync re-extracts only changed files, with the same graph as a full graphify run', { skip: !fs.existsSync(graphifyPy) && 'graphify is not installed' }, () => {
  const dir = makeProject({
    'pkg/__init__.py': '',
    'pkg/a.py': 'from .b import helper\n\ndef main():\n    return helper()\n',
    'pkg/b.py': 'def helper():\n    return 1\n',
    'pkg/c.py': 'def other():\n    return 2\n',
  }, { repos: ['.'] });
  try {
    const sync = (...a) => execFileSync(process.execPath, [path.join(SKILL, 'scripts', 'graphify-sync.mjs'), dir, ...a], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    execFileSync('graphify', ['update', dir, '--force'], { cwd: dir, stdio: 'ignore' });
    assert.match(sync(), /up to date/);
    fs.writeFileSync(path.join(dir, 'pkg/c.py'), 'from .b import helper\n\ndef other():\n    return helper() + 2\n');
    fs.rmSync(path.join(dir, 'pkg/a.py'));
    const res = JSON.parse(sync('--json').trim().split('\n').pop());
    assert.equal(res.changed, 1);
    assert.equal(res.removed, 1);
    const inc = readJson(path.join(dir, 'graphify-out', 'graph.json'));
    fs.rmSync(path.join(dir, 'graphify-out', 'graph.json'));
    execFileSync('graphify', ['update', dir, '--force'], { cwd: dir, stdio: 'ignore' });
    const full = readJson(path.join(dir, 'graphify-out', 'graph.json'));
    const ids = (g) => g.nodes.map((n) => n.id).sort();
    const edges = (g) => g.links.map((e) => `${[e.source, e.target].sort().join(' ')} ${e.relation}`).sort();
    assert.deepEqual(ids(inc), ids(full));
    assert.deepEqual(edges(inc), edges(full));
  } finally { cleanup(dir); }
});
