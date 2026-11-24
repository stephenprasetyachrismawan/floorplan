// Odoo addons: what a module is made of and how its files reach each other.
//
// Odoo files rarely import each other. They meet through the model registry (`_inherit = 'sale.order'`,
// `self.env['purchase.order']`), through XML ids (`inherit_id ref="purchase.purchase_order_form"`, menus that
// open actions), through the manifest (`data`, `assets`, `depends`), and through the web client (`orm.call`,
// `rpc('/route')`, Owl templates by name). This file reads those per file (odooExtract, cached with the rest of
// the scan) and joins them across files (odooLink), so the map shows the connections an Odoo developer means.

import path from 'node:path';

const P = path.posix;
export const MANIFEST = '__manifest__.py';

// ---------- where the addons are ----------

/** Folders holding a __manifest__.py, as path prefixes ending in '/' ('' for an addon at the root). */
export const odooRoots = (paths) => new Set(paths.filter((p) => p === MANIFEST || p.endsWith('/' + MANIFEST)).map((p) => p.slice(0, -MANIFEST.length)));

/** The addon a file belongs to: the deepest folder above it with a manifest. */
export function moduleOf(p, roots) {
  let best = null;
  for (const r of roots) if (p.startsWith(r) && (best === null || r.length > best.length)) best = r;
  return best;
}
export const moduleName = (root) => (root ? P.basename(root.replace(/\/$/, '')) : '');

/** XML and access CSVs inside an addon are code for Odoo: views, actions, menus and rights live there. */
export function odooClassify(relPath, roots) {
  if (!roots?.size) return null;
  const root = moduleOf(relPath, roots);
  if (root === null) return null;
  const rest = relPath.slice(root.length);
  const ext = P.extname(relPath).toLowerCase();
  if (ext === '.xml' && !/^static\/description\//.test(rest)) return { category: 'code', lang: 'xml' };
  if (ext === '.csv' && /(^|\/)ir\.model\.access\.csv$/.test(rest)) return { category: 'code', lang: 'csv' };
  return null;
}

// ---------- per file ----------

const lineAt = (src) => {
  const starts = [0];
  for (let i = src.indexOf('\n'); i >= 0; i = src.indexOf('\n', i + 1)) starts.push(i + 1);
  return (idx) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1; } return lo + 1; };
};
const strList = (text) => [...String(text || '').matchAll(/['"]([^'"\n]+)['"]/g)].map((m) => m[1]);
const pyValue = (body, key) => {
  // `key = 'x'` or `key = ['a', 'b']` (one or several lines), at class level
  const m = new RegExp(`^[ \\t]+${key}\\s*=\\s*(\\[[^\\]]*\\]|\\([^)]*\\)|['"][^'"\\n]+['"])`, 'm').exec(body);
  return m ? strList(m[1]) : [];
};
const pyDict = (body, key) => {
  const m = new RegExp(`^[ \\t]+${key}\\s*=\\s*\\{([^}]*)\\}`, 'm').exec(body);
  return m ? [...m[1].matchAll(/['"]([\w.]+)['"]\s*:/g)].map((x) => x[1]) : [];
};

function pyManifest(src) {
  const get = (key) => { const m = new RegExp(`['"]${key}['"]\\s*:\\s*(['"])((?:(?!\\1).)*)\\1`, 's').exec(src); return m ? m[2].trim() : ''; };
  const list = (key) => { const m = new RegExp(`['"]${key}['"]\\s*:\\s*\\[([^\\]]*)\\]`, 's').exec(src); return m ? strList(m[1].replace(/#[^\n]*/g, '')) : []; };
  const assets = [];
  const am = /['"]assets['"]\s*:\s*\{/.exec(src);
  if (am) {
    let depth = 0, i = am.index + am[0].length - 1, end = i;
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) { end = i; break; } }
    for (const m of src.slice(am.index, end).matchAll(/['"]([\w./*-]+\.(?:js|xml|scss|css))['"]/g)) assets.push(m[1]);
  }
  return {
    name: get('name'), summary: get('summary'), category: get('category'), version: get('version'),
    depends: list('depends'), data: [...list('data'), ...list('demo')], assets,
    application: /['"]application['"]\s*:\s*True/.test(src),
  };
}

/**
 * Python source with comment lines and statement-level triple-quoted strings (docstrings, and code parked inside
 * """ ... """) blanked, newlines kept so line numbers still hold. A class or env['x'] in there is not code.
 */
export function pyCode(src) {
  const blank = (t) => t.replace(/[^\n]/g, ' ');
  return src
    .replace(/^([ \t]*)("""|''')([\s\S]*?)\2/gm, (m, ind, q, body) => ind + q + blank(body) + q)
    .replace(/^([ \t]*)#.*$/gm, (m, ind) => ind);
}

// a check that the caller is who it claims to be (HMAC signature, constant-time token compare, portal access)
const VERIFIES = /hmac\.compare_digest\(|\bconsteq\(|_document_check_access\(/;
// SQL identifiers an f-string may safely carry: the model's own table
const SAFE_SQL_PART = /^\s*(self\.|cls\.|model\.)?_table\s*$/;

function pyOdoo(raw, p) {
  const out = {};
  if (P.basename(p) === MANIFEST) { out.manifest = pyManifest(raw); return out; }
  const src = pyCode(raw);
  const at = lineAt(src);
  // models: each class body with _name / _inherit / _inherits
  const classes = [...src.matchAll(/^class\s+(\w+)\s*\(([^)]*)\)\s*:/gm)];
  const models = [];
  classes.forEach((c, i) => {
    const body = src.slice(c.index, i + 1 < classes.length ? classes[i + 1].index : src.length);
    const base = c[2];
    const isModel = /\bmodels\.(Model|TransientModel|AbstractModel)\b|\b(Model|TransientModel|AbstractModel)\b/.test(base);
    if (!isModel) return;
    const name = pyValue(body, '_name')[0] || null;
    const inherit = pyValue(body, '_inherit');
    const inherits = pyDict(body, '_inherits');
    if (!name && !inherit.length) return;
    const kind = /TransientModel/.test(base) ? 'wizard' : /AbstractModel/.test(base) ? 'abstract' : 'model';
    const desc = (/^[ \t]+_description\s*=\s*(['"])((?:(?!\1).)+)\1/m.exec(body) || [])[2] || '';
    const fields = [...body.matchAll(/^[ \t]+(\w+)\s*=\s*fields\.(\w+)\(/gm)];
    const computes = fields.filter((f) => new RegExp(`^[ \\t]+${f[1]}\\s*=\\s*fields\\.\\w+\\([^)]*compute\\s*=`, 'ms').test(body.slice(body.indexOf(f[0]), body.indexOf(f[0]) + 600))).length;
    const rel = [...body.matchAll(/fields\.(?:Many2one|One2many|Many2many)\(\s*(?:comodel_name\s*=\s*)?['"]([\w.]+)['"]/g)].map((m) => m[1]);
    models.push({
      cls: c[1], line: at(c.index), kind, name, inherit, inherits, desc,
      fields: fields.length, computes,
      constrains: (body.match(/@api\.constrains\(/g) || []).length,
      onchanges: (body.match(/@api\.onchange\(/g) || []).length,
      overrides: [...body.matchAll(/^[ \t]+def\s+(create|write|unlink|copy|default_get|name_get|_compute_display_name)\s*\(/gm)].map((m) => m[1]),
      buttons: [...body.matchAll(/^[ \t]+def\s+(action_\w+|button_\w+)\s*\(/gm)].length,
      rel: [...new Set(rel)],
    });
  });
  if (models.length) out.models = models;
  const env = new Map();
  for (const m of src.matchAll(/\benv\s*\[\s*['"]([\w.]+)['"]\s*\]/g)) if (!env.has(m[1])) env.set(m[1], at(m.index));
  // `if 'x.y' not in self.env: return`: the code runs only when the addon defining x.y is installed
  const guarded = new Set([...src.matchAll(/['"]([\w.]+)['"]\s+(?:not\s+)?in\s+(?:self\.|request\.|cls\.)?env\b/g)].map((m) => m[1]));
  if (env.size) out.env = [...env].map(([model, line]) => ({ model, line, ...(guarded.has(model) ? { guarded: true } : {}) }));
  // data files a hook loads itself: tools.convert_file(env, module, os.path.join(path, 'data', 'x.xml'), ...)
  const loads = new Set();
  for (const m of src.matchAll(/os\.path\.join\(([^\n]*?\.(?:xml|csv)['"])\s*\)/g)) {
    const parts = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
    if (parts.length && /\.(xml|csv)$/.test(parts[parts.length - 1])) loads.add(parts.join('/'));
  }
  for (const m of src.matchAll(/convert_file\([^)]*?['"]([\w./-]+\.(?:xml|csv))['"]/g)) loads.add(m[1]);
  if (loads.size) out.loads = [...loads];
  const refs = new Map();
  for (const m of src.matchAll(/\.ref\(\s*['"]([\w]+\.[\w.]+)['"]/g)) if (!refs.has(m[1])) refs.set(m[1], at(m.index));
  if (refs.size) out.refs = [...refs].map(([id, line]) => ({ id, line }));
  // controllers: @http.route('/path', type='json', auth='public', csrf=False, methods=['POST'])
  const routes = [];
  for (const m of src.matchAll(/@(?:http\.)?route\(\s*([\s\S]*?)\)\s*\n\s*def\s+(\w+)/g)) {
    const args = m[1];
    const paths = /^\s*\[/.test(args) ? strList(args.slice(0, args.indexOf(']') + 1)) : strList((/^\s*(['"][^'"]+['"])/.exec(args) || [])[1]);
    const opt = (k) => (new RegExp(`\\b${k}\\s*=\\s*['"]?(\\w+)`).exec(args) || [])[1] || '';
    const methods = /\bmethods\s*=\s*\[([^\]]*)\]/.exec(args);
    // the handler's body: up to the next route, class or top-level line (at most ~150 lines)
    const from = m.index + m[0].length;
    const next = /\n[ \t]*@(?:http\.)?route\(|\nclass\s|\n\S/.exec(src.slice(from));
    const body = src.slice(from, next ? from + next.index : from + 12000).split('\n').slice(0, 150).join('\n');
    for (const rp of paths) routes.push({
      path: rp.replace(/<(?:\w+(?:\([^)]*\))?:)?(\w+)>/g, ':$1'), line: at(m.index), handler: m[2],
      type: opt('type') || 'http', auth: opt('auth') || 'user', csrf: opt('csrf') !== 'False',
      methods: methods ? strList(methods[1]).map((x) => x.toUpperCase()) : [],
      sudo: /\.sudo\(\)/.test(body), writes: /\.(create|write|unlink)\(/.test(body),
      ...(VERIFIES.test(body) || VERIFIES.test(src) ? { verified: true } : {}),
    });
  }
  if (routes.length) out.routes = routes;
  const linesOf = (re) => [...src.matchAll(re)].map((m) => at(m.index));
  const sudo = linesOf(/\.sudo\(\)/g);
  if (sudo.length) out.sudo = sudo.slice(0, 200);
  // raw SQL built with % or f-strings: cr.execute("..." % x) / cr.execute(f"...")
  const sql = [];
  for (const m of src.matchAll(/\bcr\.execute\(\s*(?:f("""|'''|"|')|["'][^"'\n]*["']\s*%|["'][^"'\n]*["']\s*\.format\()/g)) {
    if (m[1]) {
      // an f-string that only interpolates the model's own table name is not an injection
      const end = src.indexOf(m[1], m.index + m[0].length);
      const parts = [...src.slice(m.index + m[0].length, end < 0 ? undefined : end).matchAll(/\{([^{}]*)\}/g)].map((x) => x[1]);
      if (parts.length && parts.every((x) => SAFE_SQL_PART.test(x))) continue;
    }
    sql.push(at(m.index));
  }
  if (sql.length) out.sqlFormat = sql;
  const delay = linesOf(/\.with_delay\(|\.delayable\(/g);
  if (delay.length) out.delay = delay.slice(0, 50);
  return out;
}

function xmlAttrs(tag) {
  const a = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"|([\w:-]+)\s*=\s*'([^']*)'/g)) a[m[1] || m[3]] = m[2] ?? m[4];
  return a;
}

function xmlOdoo(src) {
  const at = lineAt(src);
  const out = { records: [], menus: [], templates: [], owl: [] };
  for (const m of src.matchAll(/<record\b([^>]*)>([\s\S]*?)<\/record>/g)) {
    const a = xmlAttrs(m[1]);
    const body = m[2];
    const field = (name) => {
      const f = new RegExp(`<field\\b[^>]*\\bname\\s*=\\s*["']${name}["'][^>]*?(?:/>|>([^<]*)</field>)`).exec(body);
      if (!f) return null;
      const ref = /\bref\s*=\s*["']([^"']+)["']/.exec(f[0]);
      return ref ? { ref: ref[1] } : (f[1] || '').trim() || null;
    };
    const rec = { id: a.id || null, model: a.model || '', line: at(m.index) };
    const target = field('model'), resModel = field('res_model'), inh = field('inherit_id'), modelId = field('model_id'), name = field('name'), viewType = /<(form|tree|list|kanban|search|pivot|graph|calendar|gantt|activity|qweb)\b/.exec(body);
    if (typeof target === 'string') rec.target = target;
    if (typeof resModel === 'string') rec.resModel = resModel;
    if (inh?.ref) rec.inherit = inh.ref;
    if (modelId?.ref) rec.modelRef = modelId.ref;
    if (typeof name === 'string') rec.name = name.slice(0, 120);
    if (viewType && rec.model === 'ir.ui.view') rec.viewType = viewType[1] === 'tree' ? 'list' : viewType[1];
    const groups = [...body.matchAll(/\bref\(\s*['"]([\w.]+)['"]\s*\)/g)].map((x) => x[1]);
    if (groups.length) rec.uses = [...new Set(groups)].slice(0, 20);
    // buttons in a view: <button name="action_confirm" type="object">
    const buttons = [...body.matchAll(/<button\b[^>]*\bname\s*=\s*["'](\w+)["'][^>]*\btype\s*=\s*["']object["']|<button\b[^>]*\btype\s*=\s*["']object["'][^>]*\bname\s*=\s*["'](\w+)["']/g)].map((x) => x[1] || x[2]);
    if (buttons.length) rec.buttons = [...new Set(buttons)].slice(0, 60);
    out.records.push(rec);
  }
  for (const m of src.matchAll(/<menuitem\b([^>]*?)\/?>/g)) {
    const a = xmlAttrs(m[1]);
    out.menus.push({ id: a.id || null, name: a.name || '', parent: a.parent || null, action: a.action || null, line: at(m.index), seq: Number(a.sequence) || 10 });
  }
  for (const m of src.matchAll(/<template\b([^>]*)>/g)) {
    const a = xmlAttrs(m[1]);
    out.templates.push({ id: a.id || null, inherit: a.inherit_id || null, line: at(m.index) });
  }
  // Owl / QWeb client templates: t-name="module.Component", t-inherit="web.FormView"
  for (const m of src.matchAll(/<t\b([^>]*\bt-(?:name|inherit)\s*=[^>]*)>/g)) {
    const a = xmlAttrs(m[1]);
    out.owl.push({ name: a['t-name'] || null, inherit: a['t-inherit'] || null, ...(a['t-inherit-mode'] ? { mode: a['t-inherit-mode'] } : {}), line: at(m.index) });
  }
  const traw = [...src.matchAll(/\bt-raw\s*=/g)].map((m) => at(m.index));
  if (traw.length) out.traw = traw.slice(0, 50);
  for (const k of Object.keys(out)) if (!out[k].length) delete out[k];
  return out;
}

function csvOdoo(src) {
  // ir.model.access.csv: id,name,model_id:id,group_id:id,perm_read,perm_write,perm_create,perm_unlink
  const rows = src.split('\n').map((l) => l.trim()).filter(Boolean);
  const head = (rows.shift() || '').split(',');
  const mi = head.findIndex((h) => /^model_id(:id)?$/.test(h)), gi = head.findIndex((h) => /^group_id(:id)?$/.test(h));
  if (mi < 0) return {};
  const access = rows.map((r, i) => { const c = r.split(','); return { model: c[mi], group: gi >= 0 ? c[gi] || '' : '', line: i + 2, perms: c.slice(-4).join('') }; }).filter((a) => a.model);
  return access.length ? { access } : {};
}

function jsOdoo(src) {
  const at = lineAt(src);
  const out = {};
  const orm = new Map();
  // this.orm.call("model", "method"), orm.searchRead("model", …), useService("orm") results, rpc("/web/dataset/call_kw/model/method")
  for (const m of src.matchAll(/\borm\.(call|read|searchRead|search|create|write|unlink|webSearchRead|webRead|readGroup|nameGet|silent\.call)\(\s*["'`]([\w.]+)["'`](?:\s*,\s*["'`](\w+)["'`])?/g)) {
    const k = `${m[2]}|${m[1] === 'call' || m[1] === 'silent.call' ? m[3] || '' : m[1]}`;
    if (!orm.has(k)) orm.set(k, { model: m[2], method: m[1] === 'call' || m[1] === 'silent.call' ? m[3] || '' : m[1], line: at(m.index) });
  }
  for (const m of src.matchAll(/["'`]\/web\/dataset\/call_kw\/([\w.]+)\/(\w+)["'`]/g)) {
    const k = `${m[1]}|${m[2]}`;
    if (!orm.has(k)) orm.set(k, { model: m[1], method: m[2], line: at(m.index) });
  }
  // resModel: "x" in action / view descriptions opened from JS
  for (const m of src.matchAll(/\bres_?[mM]odel\s*:\s*["'`]([\w.]+)["'`]/g)) {
    const k = `${m[1]}|open`;
    if (!orm.has(k)) orm.set(k, { model: m[1], method: 'open', line: at(m.index) });
  }
  if (orm.size) out.orm = [...orm.values()].slice(0, 200);
  // rpc("/my/route") / jsonrpc('/x') / fetch('/x') to the addon's own controllers
  const calls = [];
  for (const m of src.matchAll(/\b(?:rpc|jsonrpc|rpc\.query|ajax\.jsonRpc|fetch)\(\s*["'`](\/(?!web\/dataset\/)[\w/.:${}-]*)["'`]/g)) {
    const p = m[1].replace(/\$\{[^}]*\}/g, ':x');
    calls.push({ path: p, line: at(m.index) });
  }
  if (calls.length) out.rpc = calls.slice(0, 100);
  const tpl = [...src.matchAll(/\bstatic\s+template\s*=\s*["'`]([\w.]+)["'`]|\btemplate\s*:\s*["'`]([\w.]+)["'`]/g)].map((m) => ({ name: m[1] || m[2], line: at(m.index) }));
  if (tpl.length) out.templates = tpl;
  const patches = [...src.matchAll(/\bpatch\(\s*([\w.]+)\s*[,.]/g)].map((m) => ({ target: m[1], line: at(m.index) }));
  if (patches.length) out.patches = patches.slice(0, 30);
  const registry = [...src.matchAll(/registry\s*\.category\(\s*["'](\w+)["']\s*\)\s*\.add\(\s*["']([\w.]+)["']/g)].map((m) => ({ category: m[1], key: m[2], line: at(m.index) }));
  if (registry.length) out.registry = registry.slice(0, 30);
  return out;
}

/** Odoo facts of one file, or null. Pure: depends only on the file's text and path, so the scan cache keeps it. */
export function odooExtract(src, lang, p) {
  let r = null;
  if (lang === 'python') r = pyOdoo(src, p);
  else if (lang === 'xml') r = xmlOdoo(src);
  else if (lang === 'csv') r = csvOdoo(src);
  else if (lang === 'javascript' && /(^|\/)static\/src\//.test(p)) r = jsOdoo(src);
  return r && Object.keys(r).length ? r : null;
}

// ---------- across files ----------

const modelXmlId = (model) => 'model_' + model.replace(/\./g, '_');

/**
 * Joins the per-file facts: which file defines each model and XML id, and the links between files they imply.
 * Returns { links: [{ from, to, kind, label }], core: [{ from, model, kind }], routes, screens: Map(file -> hints),
 * used: Set(files loaded by name), modules: [...], models: Map }.
 */
export function odooLink(files, roots) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const mod = new Map(); // file -> module name
  for (const f of files) { const r = moduleOf(f.path, roots); if (r !== null) mod.set(f.path, moduleName(r)); }
  const modules = [...roots].map((r) => {
    const mf = byPath.get(r + MANIFEST);
    const m = mf?.odoo?.manifest || {};
    return { ...m, title: m.name || '', root: r, name: moduleName(r), manifest: r + MANIFEST };
  });
  const moduleByName = new Map(modules.map((m) => [m.name, m]));

  // model -> where it's defined (a class with _name, not only extending itself) and every file that extends it
  const modelDefs = new Map(), modelExt = new Map();
  for (const f of files) for (const m of f.odoo?.models || []) {
    const defines = m.name && !m.inherit.includes(m.name);
    if (defines) { if (!modelDefs.has(m.name)) modelDefs.set(m.name, []); modelDefs.get(m.name).push({ file: f.path, line: m.line, m }); }
    for (const inh of m.name && !defines ? [m.name] : m.inherit) { if (!modelExt.has(inh)) modelExt.set(inh, []); modelExt.get(inh).push({ file: f.path, line: m.line }); }
  }
  // XML ids: module.id -> file
  const xmlIds = new Map();
  const full = (id, file) => (id.includes('.') ? id : `${mod.get(file) || ''}.${id}`);
  for (const f of files) {
    const o = f.odoo; if (!o) continue;
    for (const r of o.records || []) if (r.id) xmlIds.set(full(r.id, f.path), { file: f.path, line: r.line, rec: r });
    for (const t of o.templates || []) if (t.id) xmlIds.set(full(t.id, f.path), { file: f.path, line: t.line });
    for (const mn of o.menus || []) if (mn.id) xmlIds.set(full(mn.id, f.path), { file: f.path, line: mn.line, menu: mn });
  }
  for (const [model, defs] of modelDefs) for (const d of defs) {
    const k = `${mod.get(d.file)}.${modelXmlId(model)}`;
    if (!xmlIds.has(k)) xmlIds.set(k, { file: d.file, line: d.line, model });
  }
  const owlNames = new Map();
  // only definitions: an extension repeats the name it extends (t-name="mail.Chatter" t-inherit="mail.Chatter")
for (const f of files) for (const t of f.odoo?.owl || []) if (t.name && (!t.inherit || (t.mode === 'primary' && t.name !== t.inherit)) && !owlNames.has(t.name)) owlNames.set(t.name, { file: f.path, line: t.line });

  const links = [], core = [], used = new Set();
  const add = (from, to, kind, label, line, extra) => { if (to && from !== to) links.push({ from, to, kind, label, ...(line ? { line } : {}), ...extra }); };
  const toModel = (from, model, kind, line, extra) => {
    const def = modelDefs.get(model);
    if (def?.length) { for (const d of def.slice(0, 3)) add(from, d.file, kind, model, line, extra); return; }
    core.push({ from, model, kind });
  };
  const refTarget = (id, from) => xmlIds.get(full(id, from)) || null;
  const modelFromRef = (ref, from) => {
    const t = refTarget(ref, from);
    if (t?.model) return t.model;
    const m = /(?:^|\.)model_(\w+)$/.exec(ref);
    if (!m) return null;
    // model_purchase_builder -> purchase.builder (any known model whose id matches)
    for (const name of [...modelDefs.keys(), ...modelExt.keys()]) if (modelXmlId(name) === 'model_' + m[1]) return name;
    return m[1].replace(/_/g, '.');
  };

  for (const f of files) {
    const o = f.odoo; if (!o) continue;
    for (const m of o.models || []) {
      const defines = m.name && !m.inherit.includes(m.name);
      for (const inh of m.inherit) {
        if (defines && inh === m.name) continue;
        // mixins (mail.thread …) are core: link once, as what the model is built on
        toModel(f.path, inh, 'inherit', m.line);
      }
      for (const inh of m.inherits) toModel(f.path, inh, 'inherit', m.line);
      if (!defines && m.name && !m.inherit.length) toModel(f.path, m.name, 'inherit', m.line);
      for (const r of m.rel) if (modelDefs.has(r)) toModel(f.path, r, 'model', m.line);
    }
    for (const e of o.env || []) toModel(f.path, e.model, 'model', e.line, e.guarded ? { guarded: true } : undefined);
    for (const l of o.loads || []) {
      const r = moduleOf(f.path, roots);
      if (r === null) continue;
      for (const q of byPath.keys()) if (q.startsWith(r) && (q === r + l || q.endsWith('/' + l))) { add(f.path, q, 'config', 'loaded by code'); used.add(q); }
    }
    for (const r of o.refs || []) { const t = refTarget(r.id, f.path); if (t) add(f.path, t.file, 'ref', r.id, r.line); }
    for (const r of o.records || []) {
      if (r.target) toModel(f.path, r.target, 'model', r.line);
      if (r.resModel) toModel(f.path, r.resModel, 'model', r.line);
      if (r.modelRef) { const m = modelFromRef(r.modelRef, f.path); if (m) toModel(f.path, m, 'model', r.line); }
      if (r.inherit) { const t = refTarget(r.inherit, f.path); if (t) add(f.path, t.file, 'inherit', r.inherit, r.line); }
    }
    for (const mn of o.menus || []) {
      if (mn.action) { const t = refTarget(mn.action, f.path); if (t) add(f.path, t.file, 'ref', mn.action, mn.line); }
    }
    for (const t of o.templates || []) if (t.inherit) { const x = refTarget(t.inherit, f.path); if (x) add(f.path, x.file, 'inherit', t.inherit, t.line); }
    for (const t of o.owl || []) if (t.inherit) { const x = owlNames.get(t.inherit); if (x) add(f.path, x.file, 'inherit', t.inherit, t.line); }
    for (const a of o.access || []) { const m = modelFromRef(a.model, f.path); if (m) toModel(f.path, m, 'model', a.line); }
    for (const c of o.orm || []) toModel(f.path, c.model, 'rpc', c.line);
    if (f.lang === 'javascript') for (const t of o.templates || []) { const x = owlNames.get(t.name); if (x) add(f.path, x.file, 'ref', t.name, t.line); }
    // manifest: the files it loads, and the custom addons it depends on
    if (o.manifest) {
      const r = moduleOf(f.path, roots);
      for (const d of o.manifest.data || []) { const p = r + d; if (byPath.has(p)) { add(f.path, p, 'config', 'data'); used.add(p); } }
      for (const a of o.manifest.assets || []) {
        const p = r.slice(0, -(moduleName(r).length + 1)) + a; // assets are "module/static/…"
        if (byPath.has(p)) { add(f.path, p, 'config', 'assets'); used.add(p); }
        else if (/\*/.test(a)) { const re = globRe(r.slice(0, -(moduleName(r).length + 1)) + a); for (const q of byPath.keys()) if (re.test(q)) used.add(q); }
      }
      for (const dep of o.manifest.depends || []) { const m = moduleByName.get(dep); if (m && byPath.has(m.manifest)) add(f.path, m.manifest, 'import', `depends ${dep}`); }
    }
  }
  // everything an addon loads by name is in use: models through __init__, tests by the runner, migrations by -u
  for (const f of files) {
    if (!mod.has(f.path)) continue;
    const rest = f.path.slice(moduleOf(f.path, roots).length);
    if (/^(migrations|upgrades|tests|static\/(src|tests|lib))\//.test(rest) || P.basename(f.path) === MANIFEST || f.odoo?.models || f.odoo?.routes) used.add(f.path);
  }

  // routes, in the shape the scan's other frameworks use
  const routes = [];
  for (const f of files) for (const r of f.odoo?.routes || []) {
    const methods = r.type === 'json' ? ['POST'] : r.methods.length ? r.methods : ['ANY'];
    const name = r.handler.replace(/_/g, ' ').replace(/^\s+|\s+$/g, '').replace(/^./, (c) => c.toUpperCase());
    const desc = `Odoo ${r.type} route, auth=${r.auth}${r.csrf ? '' : ', csrf=False'}${r.sudo ? ', uses sudo()' : ''}${r.writes ? ', writes records' : ''}; handled by ${r.handler}().`;
    for (const method of methods) routes.push({ file: f.path, method, path: r.path, line: r.line, handler: r.handler, framework: 'odoo', name, desc, who: `auth=${r.auth}${r.type === 'json' ? ' · json' : ''}${r.csrf ? '' : ' · csrf=False'}`, odoo: { auth: r.auth, type: r.type, csrf: r.csrf } });
  }

  // menus → screens: the full menu path, on the file that holds the window action it opens
  const menus = new Map();
  for (const f of files) for (const mn of f.odoo?.menus || []) if (mn.id) menus.set(full(mn.id, f.path), { ...mn, file: f.path });
  const menuPath = (key, guard = 0) => {
    const m = menus.get(key); if (!m || guard > 8) return [];
    const parent = m.parent ? (m.parent.includes('.') ? m.parent : `${key.split('.')[0]}.${m.parent}`) : null;
    return [...(parent ? menuPath(parent, guard + 1) : []), m.name || key.split('.').pop()];
  };
  const screens = new Map();
  for (const [key, m] of menus) {
    if (!m.action) continue;
    const t = refTarget(m.action, m.file);
    if (!t?.rec) continue;
    const parts = menuPath(key).filter(Boolean);
    const url = '/' + (parts.length ? parts.join(' / ') : m.action);
    const file = t.file;
    if (!screens.has(file)) screens.set(file, []);
    if (screens.get(file).length < 12) screens.get(file).push({ url, fw: 'odoo', model: t.rec.resModel || null });
  }
  return { links, core, routes, screens, used, modules, modelDefs, modelExt, xmlIds, mod };
}

function globRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// ---------- names and descriptions for developers ----------

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** A short developer-facing name and description from what the file defines, or null. */
export function odooDescribe(f, ctx) {
  const o = f.odoo; if (!o) return null;
  const b = P.basename(f.path);
  if (o.manifest) {
    const m = o.manifest;
    return { name: `${m.name || ctx.mod.get(f.path)} (manifest)`, desc: [`Addon ${ctx.mod.get(f.path)} ${m.version || ''}`.trim() + (m.category ? ` · ${m.category}` : ''), m.summary, m.depends?.length ? `depends: ${m.depends.join(', ')}` : ''].filter(Boolean).join('. ') };
  }
  if (o.models?.length) {
    const parts = o.models.map((m) => {
      const defines = m.name && !m.inherit.includes(m.name);
      const what = defines ? `${m.kind === 'wizard' ? 'Wizard' : m.kind === 'abstract' ? 'Abstract model' : 'Model'} ${m.name}${m.desc ? ` (${m.desc})` : ''}` : `Extends ${(m.name ? [m.name] : m.inherit).join(', ')}`;
      const extra = [m.fields && plural(m.fields, 'field'), m.computes && plural(m.computes, 'compute'), m.constrains && plural(m.constrains, 'constraint'), m.onchanges && plural(m.onchanges, 'onchange'), m.buttons && plural(m.buttons, 'button method'), m.overrides.length && `overrides ${m.overrides.join('/')}`].filter(Boolean).join(', ');
      const mix = defines && m.inherit.length ? `; built on ${m.inherit.join(', ')}` : '';
      return `${what}${extra ? `: ${extra}` : ''}${mix}`;
    });
    const first = o.models[0];
    const name = first.name && !first.inherit.includes(first.name) ? first.name : `${(first.name ? [first.name] : first.inherit)[0]} (ext)`;
    return { name: o.models.length > 1 ? `${name} +${o.models.length - 1}` : name, desc: parts.join('. ') + '.' };
  }
  if (o.routes?.length) return { name: `Controller ${b.replace(/\.py$/, '')}`, desc: `HTTP endpoints: ${o.routes.slice(0, 6).map((r) => `${r.path} (${r.type}, auth=${r.auth})`).join('; ')}${o.routes.length > 6 ? ` … +${o.routes.length - 6}` : ''}.` };
  if (o.access?.length) return { name: 'Access rights', desc: `ir.model.access for ${plural(new Set(o.access.map((a) => a.model)).size, 'model')} (${plural(o.access.length, 'rule')}).` };
  if (o.records || o.menus || o.templates || o.owl) {
    const views = (o.records || []).filter((r) => r.model === 'ir.ui.view');
    const actions = (o.records || []).filter((r) => /^ir\.actions\./.test(r.model));
    const others = (o.records || []).filter((r) => r.model !== 'ir.ui.view' && !/^ir\.actions\./.test(r.model));
    const models = [...new Set(views.map((v) => v.target).filter(Boolean))];
    const bits = [];
    if (views.length) bits.push(`${plural(views.length, 'view')} (${[...new Set(views.map((v) => v.viewType || (v.inherit ? 'inherit' : 'view')))].join('/')})${models.length ? ` of ${models.slice(0, 4).join(', ')}${models.length > 4 ? '…' : ''}` : ''}`);
    const inh = views.filter((v) => v.inherit).map((v) => v.inherit);
    if (inh.length) bits.push(`inherits ${[...new Set(inh)].slice(0, 3).join(', ')}${inh.length > 3 ? '…' : ''}`);
    if (actions.length) bits.push(`${plural(actions.length, 'action')}${actions.some((a) => a.resModel) ? ` on ${[...new Set(actions.map((a) => a.resModel).filter(Boolean))].slice(0, 3).join(', ')}` : ''}`);
    if (o.menus?.length) bits.push(plural(o.menus.length, 'menu'));
    const crons = others.filter((r) => r.model === 'ir.cron');
    if (crons.length) bits.push(plural(crons.length, 'cron'));
    const rest = others.filter((r) => r.model !== 'ir.cron');
    if (rest.length) bits.push(`${plural(rest.length, 'record')} (${[...new Set(rest.map((r) => r.model))].slice(0, 3).join(', ')})`);
    if (o.templates?.length) bits.push(plural(o.templates.length, 'QWeb template'));
    if (o.owl?.length) bits.push(`Owl templates ${o.owl.map((t) => t.name || t.inherit).filter(Boolean).slice(0, 3).join(', ')}`);
    const kind = views.length ? 'Views' : actions.length ? 'Actions' : crons.length ? 'Crons' : o.owl ? 'Client templates' : o.templates ? 'QWeb templates' : 'Data';
    return { name: `${kind} ${b.replace(/\.xml$/, '')}`, desc: bits.join('; ') + '.' };
  }
  if (o.orm || o.rpc || o.patches || o.registry) {
    const bits = [];
    if (o.templates?.length) bits.push(`component (template ${o.templates[0].name})`);
    if (o.patches?.length) bits.push(`patches ${[...new Set(o.patches.map((p) => p.target))].slice(0, 3).join(', ')}`);
    if (o.registry?.length) bits.push(`registers ${o.registry.slice(0, 3).map((r) => `${r.category}:${r.key}`).join(', ')}`);
    if (o.orm?.length) bits.push(`calls ${o.orm.slice(0, 4).map((c) => `${c.model}${c.method ? '.' + c.method : ''}`).join(', ')}${o.orm.length > 4 ? '…' : ''}`);
    if (o.rpc?.length) bits.push(`rpc ${o.rpc.slice(0, 3).map((c) => c.path).join(', ')}`);
    return { name: null, desc: `Web client: ${bits.join('; ')}.` };
  }
  return null;
}

/**
 * For an addon file Odoo facts don't name (tests, migrations, package inits, plain Python, web client code,
 * styles): a developer description from its path and what it defines. Null outside addons.
 */
export function odooFallback(f, roots) {
  const r = moduleOf(f.path, roots);
  if (r === null || f.category !== 'code') return null;
  const rest = f.path.slice(r.length);
  const b = P.basename(f.path);
  const syms = (f.symbols || []).map((x) => x.name);
  const list = (xs, n = 5) => `${xs.slice(0, n).join(', ')}${xs.length > n ? ` +${xs.length - n}` : ''}`;
  const mig = /^(?:migrations|upgrades)\/([^/]+)\/(pre|post|end)[-_]?(.*)\.py$/.exec(rest);
  if (mig) return { name: `Migration ${mig[1]} ${mig[2]}`, desc: `${mig[2]}-migration to ${mig[1]}${mig[3] ? ` (${mig[3].replace(/[-_]/g, ' ')})` : ''}, run by Odoo when the addon is upgraded${f.doc ? `: ${f.doc}` : '.'}` };
  if (b === '__init__.py') {
    const subs = [...new Set((f.imports || []).flatMap((i) => i.names?.length ? i.names : [String(i.spec || '').replace(/^\.+/, '')]).filter(Boolean))];
    return { name: `${P.basename(P.dirname(f.path))} package`, desc: subs.length ? `Package init: imports ${list(subs, 8)}.` : 'Package init.' };
  }
  if (/^tests?\//.test(rest) && f.lang === 'python') {
    const classes = (f.symbols || []).filter((x) => x.kind === 'class').map((x) => x.name);
    return { name: null, desc: `Tests${classes.length ? ` ${list(classes, 3)}` : ''}${f.doc ? `: ${f.doc}` : ''}.` };
  }
  if (/^static\//.test(rest)) {
    if (f.lang === 'css') return { name: null, desc: `Web client styles (${rest.replace(/^static\/(src\/)?/, '').replace(/\/[^/]+$/, '') || 'static'}).` };
    if (/^static\/tests?\//.test(rest) || /(^|\/)tests?\//.test(rest)) return { name: null, desc: `Web client tests${syms.length ? `: ${list(syms, 3)}` : ''}.` };
    if (f.lang === 'javascript' || f.lang === 'typescript') return { name: null, desc: `Web client code${syms.length ? `: ${list(syms)}` : ''}${f.doc ? `. ${f.doc}` : '.'}` };
  }
  if (f.lang === 'python' && syms.length) return { name: null, desc: `Python: ${list(syms)}${f.doc ? `. ${f.doc}` : '.'}` };
  if (f.lang === 'xml') return { name: null, desc: 'XML data (no Odoo records found).' };
  return null;
}
