// Odoo addons: models, XML ids, manifests and the web client joined across files (lib/odoo.mjs), the Odoo
// Health checks (lib/odoo-health.mjs), menus as screens, and odoo-arch.mjs writing architecture.json.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeProject, run, readJson, readGraph, cleanup } from './helpers.mjs';

const root = makeProject({
  'shop/__init__.py': 'from . import models\nfrom . import controllers\n',
  'shop/__manifest__.py': "{\n  'name': 'Shop',\n  'version': '17.0.1.0',\n  'category': 'Sales',\n  'depends': ['sale'],\n  'data': ['security/ir.model.access.csv', 'views/shop_order_views.xml'],\n  'assets': {'web.assets_backend': ['shop/static/src/**/*']},\n}\n",
  'shop/models/__init__.py': 'from . import shop_order\n',
  'shop/models/shop_order.py': [
    'from odoo import api, fields, models',
    '',
    'class ShopOrder(models.Model):',
    "    _name = 'shop.order'",
    "    _description = 'Shop Order'",
    "    _inherit = ['mail.thread']",
    '',
    "    name = fields.Char()",
    "    total = fields.Float(compute='_compute_total')",
    "    partner_id = fields.Many2one('res.partner')",
    '',
    "    def action_confirm(self):",
    "        self.env['sale.order'].create({})",
    '',
    'class Ghost(models.Model):',
    "    _name = 'shop.ghost'",
    '',
    'class SaleOrder(models.Model):',
    "    _inherit = 'sale.order'",
    '',
    '    def _x(self):',
    '        self.env.cr.execute("SELECT * FROM shop_order WHERE name = \'%s\'" % self.name)',
  ].join('\n'),
  'shop/controllers/__init__.py': 'from . import main\n',
  'shop/controllers/main.py': [
    'from odoo import http',
    'from odoo.http import request',
    '',
    'class Main(http.Controller):',
    "    @http.route('/shop/order/<int:order_id>', type='json', auth='user')",
    '    def order(self, order_id):',
    "        return request.env['shop.order'].browse(order_id).read()",
    '',
    "    @http.route('/shop/public/confirm', type='http', auth='public', csrf=False)",
    '    def confirm(self, **kw):',
    "        request.env['shop.order'].sudo().create({'name': kw.get('n')})",
  ].join('\n'),
  'shop/security/ir.model.access.csv': 'id,name,model_id:id,group_id:id,perm_read,perm_write,perm_create,perm_unlink\naccess_shop_order,shop.order,model_shop_order,base.group_user,1,1,1,1\n',
  'shop/views/shop_order_views.xml': [
    '<odoo>',
    '  <record id="view_shop_order_form" model="ir.ui.view">',
    '    <field name="name">shop.order.form</field>',
    '    <field name="model">shop.order</field>',
    '    <field name="arch" type="xml"><form><button name="action_confirm" type="object"/></form></field>',
    '  </record>',
    '  <record id="action_shop_order" model="ir.actions.act_window">',
    '    <field name="name">Orders</field>',
    '    <field name="res_model">shop.order</field>',
    '  </record>',
    '  <menuitem id="menu_shop_root" name="Shop"/>',
    '  <menuitem id="menu_shop_orders" name="Orders" parent="menu_shop_root" action="action_shop_order"/>',
    '</odoo>',
  ].join('\n'),
  'shop/views/forgotten.xml': '<odoo><record id="x" model="ir.ui.view"><field name="model">shop.order</field></record></odoo>\n',
  'shop/static/src/order_widget.js': "/** @odoo-module */\nexport class W { static template = 'shop.OrderWidget';\n  async load() { await this.orm.call('shop.order', 'action_confirm', [[1]]); await rpc('/shop/order/1'); } }\n",
  'shop/static/src/order_widget.xml': '<templates><t t-name="shop.OrderWidget"><div/></t></templates>\n',
  'shop_extra/__init__.py': 'from . import models\n',
  'shop_extra/__manifest__.py': "{'name': 'Shop extra', 'depends': ['sale'], 'data': ['views/extra_views.xml']}\n",
  'shop_extra/models/__init__.py': 'from . import order\n',
  'shop_extra/models/order.py': "from odoo import models, fields\n\nclass ShopOrder(models.Model):\n    _inherit = 'shop.order'\n    note = fields.Text()\n",
  'shop_extra/views/extra_views.xml': '<odoo><record id="view_shop_order_form_extra" model="ir.ui.view"><field name="model">shop.order</field><field name="inherit_id" ref="shop.view_shop_order_form"/></record></odoo>\n',
}, { repos: ['.'] });
after(() => cleanup(root));

const linkKeys = (scan, kind) => scan.odoo.links.filter((l) => l.kind === kind).map((l) => `${l.from} -> ${l.to} ${l.label}`).sort();

test('the scan joins models, XML ids, manifests and the web client across files', () => {
  run('scan.mjs', root);
  const scan = readJson(path.join(root, 'floorplan', '.cache', 'scan.json'));
  assert.deepEqual(scan.odoo.modules.map((m) => m.name).sort(), ['shop', 'shop_extra']);
  assert.deepEqual(scan.odoo.models.map((m) => m.name).sort(), ['shop.ghost', 'shop.order']);
  // XML and the access CSV are code inside an addon
  assert.equal(scan.files.find((f) => f.path === 'shop/views/shop_order_views.xml').category, 'code');
  assert.deepEqual(linkKeys(scan, 'inherit'), [
    'shop_extra/models/order.py -> shop/models/shop_order.py shop.order',
    'shop_extra/views/extra_views.xml -> shop/views/shop_order_views.xml shop.view_shop_order_form',
  ]);
  assert.ok(linkKeys(scan, 'model').includes('shop/views/shop_order_views.xml -> shop/models/shop_order.py shop.order'));
  assert.ok(linkKeys(scan, 'model').includes('shop/security/ir.model.access.csv -> shop/models/shop_order.py shop.order'));
  assert.deepEqual(linkKeys(scan, 'rpc'), ['shop/static/src/order_widget.js -> shop/models/shop_order.py shop.order']);
  assert.deepEqual(linkKeys(scan, 'ref'), ['shop/static/src/order_widget.js -> shop/static/src/order_widget.xml shop.OrderWidget']);
  assert.ok(linkKeys(scan, 'config').includes('shop/__manifest__.py -> shop/views/shop_order_views.xml data'));
  // Odoo's own models are recorded for the "Odoo standard" part
  assert.ok(scan.odoo.core.some((c) => c.from === 'shop/models/shop_order.py' && c.model === 'sale.order'));
  // controllers: auth and type, and the web client's rpc() reaches them
  assert.deepEqual(scan.routes.filter((r) => r.framework === 'odoo').map((r) => `${r.method} ${r.path} ${r.who}`).sort(), [
    'ANY /shop/public/confirm auth=public · csrf=False',
    'POST /shop/order/:order_id auth=user · json',
  ]);
  assert.deepEqual(scan.http.map((h) => `${h.from} -> ${h.path}`), ['shop/static/src/order_widget.js -> /shop/order/:order_id']);
  // a menu that opens an action is a screen
  const hints = scan.files.flatMap((f) => (f.screens || []).map((h) => `${f.path} ${h.url} ${h.model}`));
  assert.deepEqual(hints, ['shop/views/shop_order_views.xml /Shop / Orders shop.order']);
});

test('Odoo Health: public sudo, formatted SQL, models without access, files no manifest loads, missing depends', () => {
  run('odoo-arch.mjs', root);
  run('build.mjs', root, '--no-claude-md');
  const g = readGraph(root);
  const ids = g.health.issues.map((i) => i.id);
  for (const id of ['odoo-public-sudo', 'odoo-sql-format', 'odoo-no-access', 'odoo-not-loaded', 'odoo-missing-depends']) assert.ok(ids.includes(id), `expected ${id} in ${ids.join(', ')}`);
  const at = (id) => g.health.issues.find((i) => i.id === id);
  assert.deepEqual(at('odoo-no-access').locations.map((l) => l.file), ['shop/models/shop_order.py']); // shop.ghost
  assert.match(at('odoo-no-access').notes['f:shop/models/shop_order.py'], /shop\.ghost/);
  assert.deepEqual(at('odoo-not-loaded').locations.map((l) => l.file), ['shop/views/forgotten.xml']);
  assert.match(at('odoo-missing-depends').notes['f:shop_extra/models/order.py'], /shop_extra uses shop\.order from shop/);
  // the signed-in json route is not reported as open; the public one is judged by the Odoo check only
  assert.ok(!g.health.issues.some((i) => i.kind === 'unprotected-endpoint' && i.id !== 'odoo-public-sudo'));
});

test('odoo-arch.mjs writes one part per addon for developers, and the build names files from their code', () => {
  const arch = readJson(path.join(root, 'floorplan', 'architecture.json'));
  assert.equal(arch.audience, 'developers');
  assert.ok(arch.nodes.some((n) => n.id === 'sales.shop' && n.parent === 'sales'));
  assert.ok(arch.nodes.some((n) => n.id === 'odoo-core' && n.kind === 'external'));
  const g = readGraph(root);
  const f = g.files.find((x) => x.p === 'shop/models/shop_order.py');
  assert.match(f.d, /Model shop\.order \(Shop Order\)/);
  assert.ok(g.links.some((l) => l.a === 'f:shop/models/shop_order.py' && l.b === 'n:odoo-core' && l.k === 'model'));
  const screen = g.screens.find((s) => s.url === '/Shop / Orders');
  assert.ok(screen.behind.some((b) => b.id === 'f:shop/models/shop_order.py'));
  assert.ok(screen.behind.some((b) => b.id === 'f:shop_extra/models/order.py'));
  // --update keeps edits and adds nothing twice
  run('odoo-arch.mjs', root, '--update');
  assert.equal(readJson(path.join(root, 'floorplan', 'architecture.json')).nodes.length, arch.nodes.length);
});
