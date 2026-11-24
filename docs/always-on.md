# An always-on map (Odoo, graphify)

This fork adds three things on top of Floorplan: Odoo-aware maps, graphify's graph drawn on the map, and updates
that touch only what changed, so a map can run as a service and stay current while you work.

## Odoo

A project with `__manifest__.py` folders is read as Odoo addons. See "Odoo projects" in
[SKILL.md](../skills/floorplan/SKILL.md). To make the first map without an agent session:

```bash
node skills/floorplan/scripts/scan.mjs <root>
node skills/floorplan/scripts/odoo-arch.mjs <root>
node skills/floorplan/scripts/build.mjs <root> --no-claude-md
```

`odoo-arch.mjs` writes `floorplan/architecture.json` for developers: one part per business area, one per addon,
one per layer (models, views, wizards, controllers, web client, reports, security, data, tests, migrations) in
addons with more than 24 files, and an "Odoo standard" part for the core models the addons extend. Edit it as you
like: `--update` (which the watcher runs) only adds addons that are new.

## graphify

When the project has `graphify-out/graph.json`, every build draws graphify's cross-file calls and inheritance (only the EXTRACTED ones: calls graphify only guessed from a matching name are left out) and
shows each file's graphify community. The graph is lifted to file level once per change of graph.json and cached
in `floorplan/.cache/graphify.json`.

`graphify update .` re-reads and re-clusters everything, which takes minutes on a large repo.
`scripts/graphify-sync.mjs <root>` does the same update for only the files that changed since the last sync:

| | `graphify update .` | `graphify-sync.mjs` |
|---|---|---|
| files read | all | changed ones, plus the files they import (from graphify's cache) |
| nodes and edges | | the same as a full update (checked by `tests/incremental.test.mjs`) |
| nodes of deleted files | kept forever | dropped |
| communities | re-clustered | kept; new nodes join their neighbours' community |
| GRAPH_REPORT.md | rewritten | left as is |

`--full` runs `graphify update . --force`. The watcher runs it once a night to re-cluster.

Put sibling worktrees and generated folders in a `.graphifyignore` (graphify reads it instead of `.gitignore`),
or `graphify update .` walks them too.

## The service

```bash
tools/service/install.sh <root> --port 4378 [--windows-autostart]
```

writes and enables a systemd user unit `floorplan-<name>.service` running
`watch.mjs <root> --serve --port 4378`. It polls the checkout every 5 seconds; after a change it runs
graphify-sync, scan (changed files only), `odoo-arch.mjs --update` and build, and open tabs reload. A one-file
edit reaches the map in about 10–15 seconds.

On WSL, `--windows-autostart` adds a hidden entry to the Windows Startup folder that starts the distro at
sign-in, so the map is up without opening a terminal. Remove the service with
`tools/service/install.sh --uninstall --name <name>`. Logs: `journalctl --user -u floorplan-<name> -f`.

## A map per branch

A map of the checkout you work in changes whenever you switch branches. To keep maps of fixed branches instead
(say what is on staging and what is in production), give each its own worktree and service:

```bash
tools/service/install.sh <repo> --follow origin/preprod --worktree ~/maps/myapp-preprod --name myapp-preprod --port 4378
tools/service/install.sh <repo> --follow origin/master  --worktree ~/maps/myapp-master  --name myapp-master  --port 4379
```

`--follow` adds the worktree (detached, at the branch) and copies the repo's `.graphifyignore` into it. The
service fetches the branch every 5 minutes (`--fetch-every`), checks out the new commit when it moved, and updates
the map as for any change. The first start runs the full graphify once for that worktree. Nothing is ever pushed
or committed there; a worktree with local edits to tracked files is left where it is and the log says so.
Remove one with `tools/service/install.sh --uninstall --name myapp-preprod --worktree ~/maps/myapp-preprod`.
