#!/usr/bin/env node
// Odoo projects: write floorplan/architecture.json from the addons the scan found, for developers.
//
// One part per business area (from each addon's name and manifest category), one child per addon, and inside a
// big addon one child per layer (models, views, wizards, controllers, web client, reports, security, data, tests,
// migrations). Odoo's own models (sale.order, res.partner …) become one external part, "Odoo standard".
//
// usage: node odoo-arch.mjs [root] [--update] [--force]
//   no architecture.json yet: writes one.
//   --update: keeps every part you wrote or edited, and only adds addons and layers that are new since.
//   --force: rewrites it from scratch.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, mapDir, readJsonFile, keepOutOfGit } from './lib/common.mjs';

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args._[0] || '.');
const outDir = mapDir(root);
const scanFile = path.join(outDir, '.cache', 'scan.json');
const archFile = path.join(outDir, 'architecture.json');
if (!fs.existsSync(scanFile)) { console.error(`✗ No scan yet. Run scan.mjs "${root}" first.`); process.exit(1); }
const scan = readJsonFile(scanFile);
if (!scan.odoo?.modules?.length) { console.error('✗ The scan found no Odoo addons (no __manifest__.py).'); process.exit(1); }
const exists = fs.existsSync(archFile);
if (exists && !args.update && !args.force) { console.log('architecture.json already exists: pass --update to add new addons, or --force to rewrite it.'); process.exit(0); }

const AREAS = [
  { id: 'sales', label: 'Sales & CRM', re: /sale|crm|lead|marketing|commission|invoic|account|pos\b|website|shop|proposal|quotation|customer/i, summary: 'Addons for selling: CRM, quotations and sale orders, commissions and invoicing.' },
  { id: 'operations', label: 'Operations', re: /purchas|manufactur|mrp|bom|furniture|inventory|warehouse|stock|quality|qc|carpentry|costing|product|planning/i, summary: 'Addons for buying, making and stocking: purchase, manufacturing (MRP), quality and inventory.' },
  { id: 'project', label: 'Project & HR', re: /project|task|gantt|timesheet|\bhr\b|employee|approval/i, summary: 'Addons for projects, tasks, approvals and people.' },
  { id: 'messaging', label: 'Documents & messaging', re: /document|whatsapp|mail|discuss|chatter|pdf|image|annot|attach|s3/i, summary: 'Addons for documents, files and images, e-mail and WhatsApp.' },
  { id: 'technical', label: 'Technical & tools', re: /.*/, summary: 'Shared utilities, imports, queue jobs, audit and technical addons.' },
];
const areaOf = (m) => AREAS.find((a) => a.re.test(m.name)) || AREAS.find((a) => a.re.test(m.category || '')) || AREAS[AREAS.length - 1];

const LAYERS = [
  { key: 'models', label: 'Models', kind: 'data', glob: 'models' },
  { key: 'views', label: 'Views & menus', kind: 'ui', glob: 'views' },
  { key: 'wizard', label: 'Wizards', kind: 'feature', glob: '{wizard,wizards}' },
  { key: 'controllers', label: 'Controllers', kind: 'service', glob: 'controllers' },
  { key: 'static', label: 'Web client', kind: 'ui', glob: 'static' },
  { key: 'report', label: 'Reports', kind: 'feature', glob: '{report,reports}' },
  { key: 'security', label: 'Security', kind: 'config', glob: 'security' },
  { key: 'data', label: 'Data', kind: 'config', glob: '{data,demo}' },
  { key: 'tests', label: 'Tests', kind: 'test', glob: 'tests' },
  { key: 'migrations', label: 'Migrations', kind: 'script', glob: '{migrations,upgrades}' },
];
const codeFiles = scan.files.filter((f) => f.category === 'code');
const slug = (s) => s.replace(/[^A-Za-z0-9_.-]/g, '_');

function moduleNodes(m, areaId) {
  const id = `${areaId}.${slug(m.name)}`;
  const mine = codeFiles.filter((f) => f.path.startsWith(m.root) && !scan.odoo.modules.some((o) => o.root !== m.root && o.root.startsWith(m.root) && f.path.startsWith(o.root)));
  const models = scan.odoo.models.filter((x) => x.files.some((p) => p.startsWith(m.root))).map((x) => x.name);
  const summary = [m.title && m.title !== m.name ? `${m.title}${m.summary ? `: ${m.summary}` : ''}` : m.summary || `Addon ${m.name}`, models.length ? `defines ${models.slice(0, 6).join(', ')}${models.length > 6 ? ` +${models.length - 6}` : ''}` : ''].filter(Boolean).join('. ').replace(/\.\./g, '.');
  const nodes = [{
    id, parent: areaId, label: m.name, kind: m.application ? 'service' : 'feature', summary: summary.slice(0, 400),
    details: [`Version ${m.version || '?'}${m.category ? ` · category ${m.category}` : ''}.`, m.depends.length ? `Depends on: ${m.depends.join(', ')}.` : ''].filter(Boolean).join('\n\n'),
    tags: ['odoo-addon', ...(m.application ? ['application'] : [])],
    paths: [m.root.replace(/\/$/, '') || '**'],
  }];
  // nested addons (doodex_crm_leads/meta_ads_leads) are their own part
  const nested = scan.odoo.modules.filter((o) => o.root !== m.root && o.root.startsWith(m.root));
  if (nested.length) nodes[0].exclude = nested.map((o) => o.root.replace(/\/$/, ''));
  if (mine.length > 24) for (const L of LAYERS) {
    const n = mine.filter((f) => new RegExp(`^${m.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(${L.glob.replace(/[{}]/g, '').split(',').join('|')})/`).test(f.path)).length;
    if (!n) continue;
    nodes.push({ id: `${id}.${L.key}`, parent: id, label: L.label, kind: L.kind, summary: `${L.label} of ${m.name} (${n} file${n === 1 ? '' : 's'}).`, paths: [`${m.root}${L.glob}/**`] });
  }
  return nodes;
}

const prev = exists && !args.force ? readJsonFile(archFile) : null;
const have = new Set((prev?.nodes || []).map((n) => n.id));
const haveAddon = new Set((prev?.nodes || []).filter((n) => (n.tags || []).includes('odoo-addon')).map((n) => n.label));
const nodes = [];
const usedAreas = new Set();
for (const m of scan.odoo.modules) {
  if (haveAddon.has(m.name)) continue;
  const a = areaOf(m);
  usedAreas.add(a.id);
  for (const n of moduleNodes(m, a.id)) if (!have.has(n.id)) nodes.push(n);
}
const areaNodes = AREAS.filter((a) => usedAreas.has(a.id) && !have.has(a.id)).map((a) => ({ id: a.id, label: a.label, kind: 'service', summary: a.summary }));
const core = have.has('odoo-core') ? [] : [{ id: 'odoo-core', label: 'Odoo standard', kind: 'external', summary: 'Odoo 17 community and enterprise: the standard models (sale.order, purchase.order, res.partner …) and mixins the addons extend or use.', packages: ['odoo'] }];
const loose = codeFiles.filter((f) => !scan.odoo.modules.some((m) => f.path.startsWith(m.root)));
const rest = !have.has('repo') && loose.length ? [{ id: 'repo', label: 'Repository tooling', kind: 'infra', summary: 'Files outside any addon: scripts, CI, end-to-end tests and tooling.', paths: ['*', '.github/**', 'scripts/**', 'tools/**', 'tests/**', 'docs/**'] }] : [];

const added = [...areaNodes, ...nodes, ...core, ...rest];
const name = path.basename(root);
const arch = prev ? { ...prev, nodes: [...prev.nodes, ...added] } : {
  $schema: 'floorplan/architecture@1',
  project: { name, summary: `Odoo 17 addons of ${name}: ${scan.odoo.modules.length} addons, ${scan.odoo.models.length} models defined.`, entrypoints: scan.odoo.modules.filter((m) => m.application).map((m) => m.manifest) },
  audience: 'developers',
  editor: 'vscode',
  ignore: ['**/i18n/**', '**/static/lib/**', '**/static/description/**'],
  nodes: added,
  edges: [],
  flows: [],
};
fs.mkdirSync(outDir, { recursive: true });
keepOutOfGit(outDir);
fs.writeFileSync(archFile, JSON.stringify(arch, null, 2) + '\n');
console.log(`${prev ? 'Updated' : 'Wrote'} ${path.relative(root, archFile)}: ${added.length} part(s) ${prev ? 'added' : ''} (${scan.odoo.modules.length} addons in ${AREAS.filter((a) => usedAreas.has(a.id)).length} areas). Next: build.mjs.`);
