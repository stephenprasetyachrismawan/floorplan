// Odoo checks for the Health panel: mistakes that are specific to Odoo addons and that a reviewer looks for
// first. Each issue has the panel's usual shape (see lib/health.mjs), so Show on map and Fix with work on them.

import path from 'node:path';
import { moduleOf, MANIFEST } from './odoo.mjs';

const P = path.posix;
const TEST = /(^|\/)tests?\//;
const listFix = (head, locs, tail) => [head, ...locs.slice(0, 40).map((l) => `- ${l.file}:${l.line}${l.what ? ` (${l.what})` : ''}`), '', tail].join('\n');
const issue = (id, kind, severity, title, detail, locs, fix, noteOf) => {
  const filesL = [...new Set(locs.map((l) => l.file))];
  return {
    id, kind, severity, title, detail,
    items: filesL.slice(0, 24).map((p) => 'f:' + p),
    notes: Object.fromEntries(filesL.slice(0, 24).map((p) => ['f:' + p, noteOf(locs.filter((l) => l.file === p))])),
    locations: locs.map(({ file, line }) => ({ file, line })),
    fix,
  };
};
const lines = (ls) => `line ${ls.map((l) => l.line).join(', ')}`;

/** Odoo issues from the scan's per-file facts and the cross-file join (odooLink). */
export function odooHealth(files, od) {
  const out = [];
  const roots = new Set(od.modules.map((m) => m.root));

  // 1. public endpoints that switch to superuser rights
  const pub = [];
  let verified = 0;
  for (const f of files) for (const r of f.odoo?.routes || []) {
    if (TEST.test(f.path) || (r.auth !== 'public' && r.auth !== 'none') || !r.sudo) continue;
    // a webhook that checks an HMAC signature or a token with a constant-time compare already verifies its caller
    if (r.verified) { verified++; continue; }
    pub.push({ file: f.path, line: r.line, what: `${r.path} auth=${r.auth}${r.writes ? ', writes records' : ''}` });
  }
  if (pub.length) out.push(issue('odoo-public-sudo', 'unprotected-endpoint', pub.some((x) => /writes/.test(x.what)) ? 'high' : 'medium',
    `${pub.length} public Odoo endpoint${pub.length === 1 ? '' : 's'} use sudo()`,
    'These routes accept callers who are not logged in (auth="public" or "none") and then run code with sudo(), which skips access rights and record rules. Anyone who finds the URL can reach whatever that code reads or changes. Check each one validates a token or the record it touches.' + (verified ? ` (${verified} other public sudo route${verified === 1 ? '' : 's'} sit in files that verify a signature or token with hmac.compare_digest / consteq and are not listed.)` : ''),
    pub,
    listFix('These Odoo controller routes are public and call sudo():', pub, 'For each, verify the caller before sudo(): check an access token (e.g. _document_check_access / consteq on access_token), limit the domain to the one record the token grants, and only sudo() the minimal read/write. Keep the route path and response format the same. Add a test that calls the route without a valid token and expects 403/404.'),
    (ls) => ls.map((l) => `${l.what} on line ${l.line}`).join('; ')));

  // 2. raw SQL built with string formatting
  const sql = [];
  for (const f of files) for (const line of f.odoo?.sqlFormat || []) if (!TEST.test(f.path)) sql.push({ file: f.path, line });
  // in migrations the formatted parts are table and column names written by the developer: worth tidying, not urgent
  const MIGRATION = /(^|\/)(migrations|upgrades)\//;
  const live = sql.filter((x) => !MIGRATION.test(x.file));
  if (sql.length) out.push(issue('odoo-sql-format', 'secret', live.length ? 'high' : 'low',
    `${sql.length} raw SQL quer${sql.length === 1 ? 'y is' : 'ies are'} built with string formatting${live.length ? (live.length < sql.length ? ` (${live.length} outside migrations)` : '') : ' (all in migrations)'}`,
    'cr.execute() is given a string assembled with %, .format() or an f-string. If any part comes from a user (a domain value, a search term, a context key) it is an SQL injection. Odoo\'s way is query parameters or odoo.tools.SQL. In migrations the formatted parts are usually table names, which is lower risk.',
    sql,
    listFix('These cr.execute calls build SQL with string formatting:', sql, 'Rewrite each to pass values as parameters: cr.execute("... WHERE id = %s", (value,)), and identifiers through odoo.tools.SQL.identifier (Odoo 17: from odoo.tools import SQL). Keep the query results identical. Run the tests of the touched modules.'),
    lines));

  // 3. models without access rights
  const accessed = new Set();
  for (const f of files) for (const a of f.odoo?.access || []) accessed.add(a.model.replace(/^.*\./, ''));
  const noAccess = [];
  for (const [name, defs] of od.modelDefs) {
    const d = defs[0];
    if (d.m.kind === 'abstract' || TEST.test(d.file)) continue;
    if (!accessed.has('model_' + name.replace(/\./g, '_'))) noAccess.push({ file: d.file, line: d.line, what: name });
  }
  if (noAccess.length) out.push(issue('odoo-no-access', 'database-rules', 'medium',
    `${noAccess.length} model${noAccess.length === 1 ? ' has' : 's have'} no access rights`,
    'No ir.model.access.csv row in the addons gives any group access to these models. Odoo logs "no access rules" at load, and every non-admin user gets an AccessError when a screen or wizard touches them.',
    noAccess,
    listFix('These models have no ir.model.access row:', noAccess, "Add rows to the owning module's security/ir.model.access.csv (id,name,model_id:id,group_id:id,perm_read,perm_write,perm_create,perm_unlink) for the groups that use them, make sure the CSV is in the manifest's data, and bump the module version."),
    (ls) => ls.map((l) => l.what).join(', ')));

  // 4. XML / CSV in an addon that its manifest never loads
  const loaded = new Set(od.used);
  const orphans = [];
  for (const f of files) {
    if (f.lang !== 'xml' && f.lang !== 'csv') continue;
    const r = moduleOf(f.path, roots);
    if (r === null) continue;
    const rest = f.path.slice(r.length);
    if (/^(static|tests|migrations|doc|readme|i18n)\//.test(rest)) continue;
    if (!loaded.has(f.path)) orphans.push({ file: f.path, line: 1, what: r + MANIFEST });
  }
  if (orphans.length) out.push(issue('odoo-not-loaded', 'unused-file', 'medium',
    `${orphans.length} XML/CSV file${orphans.length === 1 ? ' is' : 's are'} not in any manifest`,
    "These views, data or access files sit in an addon but its __manifest__.py doesn't list them in data, demo or assets, so Odoo never loads them: edits there change nothing.",
    orphans,
    listFix('These files are not loaded by their manifest:', orphans, "For each, either add it to the 'data' list of the manifest named in brackets (in load order: security first, then views, then menus) and bump the version, or delete it if it is dead."),
    () => 'not listed in the manifest'));

  // 5. an addon using another custom addon's model without depending on it
  const byName = new Map(od.modules.map((m) => [m.name, m]));
  const closure = new Map();
  const depsOf = (name, seen = new Set()) => {
    if (closure.has(name)) return closure.get(name);
    if (seen.has(name)) return new Set();
    seen.add(name);
    const all = new Set();
    for (const d of byName.get(name)?.depends || []) { all.add(d); for (const x of depsOf(d, seen)) all.add(x); }
    closure.set(name, all);
    return all;
  };
  const missing = new Map();
  for (const l of od.links) {
    if (l.kind !== 'inherit' && l.kind !== 'model') continue;
    // `if 'x.y' not in self.env`: written to run only when the other addon is installed
    if (l.guarded) continue;
    const a = od.mod.get(l.from), b = od.mod.get(l.to);
    if (!a || !b || a === b || TEST.test(l.from)) continue;
    // the model may also be defined in a module A does depend on: only flag when no defining file is reachable
    const defs = (od.modelDefs.get(l.label) || []).map((d) => od.mod.get(d.file));
    if (defs.some((m) => m === a || depsOf(a).has(m))) continue;
    if (depsOf(a).has(b)) continue;
    const k = `${a}->${b}`;
    // b already depends on a: a depends entry would be a cycle, so the use needs a guard or belongs in b
    const reverse = depsOf(b).has(a);
    if (!missing.has(k)) missing.set(k, { file: l.from, line: l.line || 1, what: `${a} uses ${l.label} from ${b}${reverse ? ` (${b} depends on ${a}: guard with 'in env' or move the code to ${b})` : ''}` });
  }
  const miss = [...missing.values()];
  if (miss.length) out.push(issue('odoo-missing-depends', 'database-rules', 'medium',
    `${miss.length} addon dependenc${miss.length === 1 ? 'y is' : 'ies are'} missing from manifests`,
    "An addon extends or uses a model that another custom addon defines, but doesn't list that addon (directly or through its depends) in __manifest__.py. Install or upgrade order then decides whether it works: a fresh install can fail with KeyError or a missing field.",
    miss,
    listFix('These addons use models of addons they do not depend on:', miss, "Add the missing addon to 'depends' in the first addon's __manifest__.py and bump its version. Where the other addon already depends on this one (noted in brackets) a depends entry would be a cycle: wrap the use in `if 'model.name' in self.env` or move that code into the other addon. Upgrade both on a test database."),
    (ls) => ls.map((l) => l.what).join('; ')));

  // 6. t-raw (removed in Odoo 17 QWeb: unsafe and deprecated)
  const traw = [];
  for (const f of files) for (const line of f.odoo?.traw || []) traw.push({ file: f.path, line });
  if (traw.length) out.push(issue('odoo-t-raw', 'cors', 'low',
    `${traw.length} QWeb template${traw.length === 1 ? ' uses' : 's use'} t-raw`,
    't-raw prints HTML without escaping. It is deprecated since Odoo 15; t-out escapes by default and prints Markup values as HTML.',
    traw,
    listFix('These templates use t-raw:', traw, 'Replace t-raw with t-out. Where the value really is trusted HTML, make the Python side return markupsafe.Markup. Check the rendered page still looks the same.'),
    lines));

  return out;
}
