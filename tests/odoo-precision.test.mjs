// Odoo Health without false alarms: code in comments and docstrings is not code, a use guarded by
// `'x' in self.env` needs no depends, a file a hook loads is loaded, an f-string carrying only the model's own
// table is not an injection, and a webhook that checks an HMAC signature verifies its caller.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, run, readGraph, cleanup } from './helpers.mjs';
import { pyCode } from '../skills/floorplan/scripts/lib/odoo.mjs';

const root = makeProject({
  'base_addon/__init__.py': 'from . import models\n',
  'base_addon/__manifest__.py': "{'name': 'Base addon', 'depends': ['base'], 'data': ['security/ir.model.access.csv']}\n",
  'base_addon/security/ir.model.access.csv': 'id,name,model_id:id,group_id:id,perm_read,perm_write,perm_create,perm_unlink\naccess_thing,thing,model_base_thing,base.group_user,1,1,1,1\n',
  'base_addon/models/__init__.py': 'from . import thing\n',
  'base_addon/models/thing.py': [
    'from odoo import models',
    '',
    'class Thing(models.Model):',
    "    _name = 'base.thing'",
    '',
    '    def _uses_top(self):',
    "        if 'top.thing' not in self.env:",
    '            return',
    "        self.env['top.thing'].search([])",
    '',
    '    def _old(self):',
    "        # self.env['other.thing'].create({})",
    '        return 1',
    '',
    '    def init(self):',
    '        self.env.cr.execute(f"UPDATE {self._table} SET name = %s WHERE id = %s", ("x", 1))',
    '',
    '    def danger(self, term):',
    '        self.env.cr.execute(f"SELECT id FROM base_thing WHERE name = \'{term}\'")',
    '',
    '"""',
    'class Parked(models.TransientModel):',
    "    _name = 'base.parked'",
    '"""',
  ].join('\n'),
  'base_addon/hooks.py': [
    'import os',
    'from odoo import tools',
    '',
    'def post_init_hook(env):',
    "    path = os.path.join(os.path.dirname(__file__), 'data', 'seed.xml')",
    "    tools.convert_file(env, 'base_addon', path, None, mode='init', noupdate=True, kind='data')",
  ].join('\n'),
  'base_addon/data/seed.xml': '<odoo><record id="seed" model="base.thing"/></odoo>\n',
  'base_addon/controllers/__init__.py': 'from . import hook\n',
  'base_addon/controllers/hook.py': [
    'import hmac',
    'from odoo import http',
    'from odoo.http import request',
    '',
    'class Hook(http.Controller):',
    "    @http.route('/hook', type='http', auth='public', csrf=False)",
    '    def hook(self, **kw):',
    '        if not self._ok():',
    '            return request.make_response("no", status=403)',
    "        request.env['base.thing'].sudo().create({})",
    '',
    '    def _ok(self):',
    "        return hmac.compare_digest('a', 'b')",
  ].join('\n'),
  'top_addon/__init__.py': '',
  'top_addon/__manifest__.py': "{'name': 'Top addon', 'depends': ['base_addon'], 'data': ['security/ir.model.access.csv']}\n",
  'top_addon/security/ir.model.access.csv': 'id,name,model_id:id,group_id:id,perm_read,perm_write,perm_create,perm_unlink\naccess_top,top,model_top_thing,base.group_user,1,1,1,1\n',
  'top_addon/models.py': "from odoo import models\n\nclass Top(models.Model):\n    _name = 'top.thing'\n",
  'other_addon/__init__.py': '',
  'other_addon/__manifest__.py': "{'name': 'Other', 'depends': ['base'], 'data': ['security/ir.model.access.csv']}\n",
  'other_addon/security/ir.model.access.csv': 'id,name,model_id:id,group_id:id,perm_read,perm_write,perm_create,perm_unlink\naccess_other,other,model_other_thing,base.group_user,1,1,1,1\n',
  'other_addon/models.py': "from odoo import models\n\nclass Other(models.Model):\n    _name = 'other.thing'\n",
}, { repos: ['.'] });
after(() => cleanup(root));

test('pyCode blanks comment lines and docstrings but keeps line numbers', () => {
  const src = "a = 1\n# env['x.y']\n\"\"\"\nclass P(models.Model):\n\"\"\"\nb = 2\n";
  const code = pyCode(src);
  assert.equal(code.split('\n').length, src.split('\n').length);
  assert.doesNotMatch(code, /env\[|class P/);
  assert.match(code, /b = 2/);
});

test('Odoo Health skips guarded uses, commented code, parked classes, hook-loaded files, own-table SQL and verified webhooks', () => {
  run('scan.mjs', root);
  run('odoo-arch.mjs', root);
  run('build.mjs', root, '--no-claude-md');
  const g = readGraph(root);
  const at = (id) => g.health.issues.find((i) => i.id === id);
  // top.thing is used behind `not in self.env` (top_addon depends on base_addon: a depends would be a cycle);
  // other.thing only appears in a comment
  assert.equal(at('odoo-missing-depends'), undefined);
  // base.parked sits inside a string: no model, so nothing to give access to
  assert.equal(at('odoo-no-access'), undefined);
  // data/seed.xml is loaded by the post_init_hook
  assert.equal(at('odoo-not-loaded'), undefined);
  // the f-string with {self._table} is fine; the one with {term} is not
  assert.deepEqual(at('odoo-sql-format').locations.map((l) => `${l.file}:${l.line}`), ['base_addon/models/thing.py:19']);
  // the public route checks an HMAC before sudo()
  assert.equal(at('odoo-public-sudo'), undefined);
});
