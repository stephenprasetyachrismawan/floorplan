// graphify → floorplan: lift graphify's symbol graph (graphify-out/graph.json) to the file-level connections
// floorplan draws, plus each file's graphify community.
//
// graphify knows things a regex scan doesn't: which function calls which across files, class inheritance
// resolved by name, and communities of code that belong together. Its graph is large (100k+ nodes), so the
// lifted result is cached in floorplan/.cache/graphify.json and rebuilt only when graph.json itself changes
// (`graphify update .` rewrites it). Reading the cache costs milliseconds.

import fs from 'node:fs';
import path from 'node:path';

export const GRAPHIFY_DIR = 'graphify-out';
// graphify relation -> floorplan link kind. Relations inside one file (method, contains, defines, rationale_for)
// and imports (the scan resolves those itself) are left out.
const RELATION_KIND = { calls: 'call', inherits: 'inherit', uses: 'call', references: 'ref', shares_data_with: 'data' };
const CACHE_VERSION = 2;

/** Where graphify keeps its graph for this root, or null when graphify hasn't run here. */
export function graphifyFile(root) {
  const f = path.join(root, GRAPHIFY_DIR, 'graph.json');
  return fs.existsSync(f) ? f : null;
}

/**
 * The lifted graph: { links: [{ from, to, kind, w, labels }], community: { file: label }, commit, nodes, at }.
 * Cached by graph.json's size and mtime; `force` rebuilds the cache.
 */
export function loadGraphify(root, cacheDir, { force = false } = {}) {
  const src = graphifyFile(root);
  if (!src) return null;
  const st = fs.statSync(src);
  const stamp = `${st.size}:${Math.round(st.mtimeMs)}`;
  const cacheFile = path.join(cacheDir, 'graphify.json');
  if (!force) {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (c.version === CACHE_VERSION && c.stamp === stamp) return c;
    } catch { /* no cache yet, or an old one */ }
  }
  const t0 = Date.now();
  const g = JSON.parse(fs.readFileSync(src, 'utf8'));
  let labels = {};
  try { labels = JSON.parse(fs.readFileSync(path.join(root, GRAPHIFY_DIR, '.graphify_labels.json'), 'utf8')); } catch { /* communities without names */ }
  const fileOf = new Map(), nameOf = new Map();
  const votes = new Map(); // file -> Map(community -> count)
  for (const n of g.nodes || []) {
    const sf = typeof n.source_file === 'string' ? n.source_file.replace(/\\/g, '/') : null;
    if (!sf) continue;
    fileOf.set(n.id, sf);
    if (n.file_type === 'code') nameOf.set(n.id, String(n.label || '').slice(0, 80));
    if (n.community != null && n.file_type === 'code') {
      if (!votes.has(sf)) votes.set(sf, new Map());
      const v = votes.get(sf);
      v.set(n.community, (v.get(n.community) || 0) + 1);
    }
  }
  const agg = new Map();
  for (const l of g.links || g.edges || []) {
    const kind = RELATION_KIND[l.relation];
    if (!kind) continue;
    const a = fileOf.get(l.source), b = fileOf.get(l.target);
    if (!a || !b || a === b) continue;
    const k = `${a}\u0000${b}\u0000${kind}`;
    let e = agg.get(k);
    if (!e) { e = { from: a, to: b, kind, w: 0, labels: [] }; agg.set(k, e); }
    e.w++;
    const name = nameOf.get(l.target);
    if (name && e.labels.length < 12 && !e.labels.includes(name)) e.labels.push(name);
  }
  const community = {};
  for (const [file, v] of votes) {
    const [best] = [...v.entries()].sort((x, y) => y[1] - x[1]);
    const label = labels[String(best[0])];
    community[file] = label ? `${label} #${best[0]}` : `#${best[0]}`;
  }
  const out = { version: CACHE_VERSION, stamp, at: new Date().toISOString(), commit: g.built_at_commit || null, nodes: (g.nodes || []).length, ms: Date.now() - t0, links: [...agg.values()], community };
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(out));
  return out;
}
