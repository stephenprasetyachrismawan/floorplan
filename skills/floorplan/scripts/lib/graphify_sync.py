"""Incremental graphify update: re-extract only the code files that changed and splice them into graph.json.

`graphify update .` walks the whole folder, re-extracts every file, re-clusters the whole graph and rewrites the
report: minutes on a large repo, even for a one-line edit. This does the part that depends on the edit:

1. Lists code files with git (tracked + untracked, honouring .gitignore, .git/info/exclude and .graphifyignore),
   and compares their size and mtime with the last sync (graphify-out/.floorplan_sync.json).
2. Re-extracts just the changed files with graphify's own extractor (same node ids as a full run).
3. Drops every node and edge of changed or deleted files (also nodes of files that no longer exist, which
   `graphify update` keeps forever), adds the fresh ones, and resolves the changed files' calls into other
   files against the whole graph with graphify's rule (a callee name that is unique in the graph).
4. Keeps every unchanged node's community; a new node joins the community most of its neighbours are in.
5. Writes graph.json in graphify's format, with built_at_commit = HEAD.

What it doesn't redo: re-clustering and GRAPH_REPORT.md, and calls from unchanged files that only become
resolvable because a name stopped being ambiguous. `--full` runs `graphify update . --force` for that
(the watcher does it once a night).

usage: <graphify python> graphify_sync.py <root> [--full] [--json] [--dry-run]
"""

import json
import os
import subprocess
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

STATE = ".floorplan_sync.json"
VERSION = 1
SKIP_PREFIXES = ("graphify-out/", "floorplan/", ".floww/", "node_modules/")


def log(msg, quiet):
    if not quiet:
        print(msg, flush=True)


def code_files(root):
    from graphify.extract import _get_extractor
    out = subprocess.run(["git", "-C", str(root), "ls-files", "-co", "--exclude-standard", "-z"],
                         capture_output=True, check=True).stdout.decode("utf-8", "replace").split("\0")
    patterns = []
    try:
        from graphify.detect import _SKIP_FILES, _is_noise_dir
    except Exception:
        _SKIP_FILES, _is_noise_dir = set(), (lambda part: False)
    try:
        from graphify.detect import _load_graphifyignore, _is_ignored
        if (root / ".graphifyignore").exists():
            patterns = _load_graphifyignore(root)
    except Exception:
        _is_ignored = None
    files = {}
    for rel in out:
        if not rel or rel.startswith(SKIP_PREFIXES):
            continue
        parts = rel.split("/")
        if parts[-1] in _SKIP_FILES or any(_is_noise_dir(x) for x in parts[:-1]):
            continue
        p = root / rel
        if _get_extractor(p) is None:
            continue
        try:
            st = p.stat()
        except OSError:
            continue
        if patterns and _is_ignored and _is_ignored(p, root, patterns):
            continue
        files[rel] = [st.st_size, int(st.st_mtime_ns // 1_000_000)]
    return files


def main():
    args = sys.argv[1:]
    root = Path(next((a for a in args if not a.startswith("--")), ".")).resolve()
    os.chdir(root)  # graphify resolves source paths against the working directory
    quiet = "--json" in args
    out_dir = root / "graphify-out"
    graph_file = out_dir / "graph.json"
    if "--full" in args:
        t0 = time.time()
        r = subprocess.run(["graphify", "update", str(root), "--force"], cwd=root)
        if r.returncode == 0:
            st = code_files(root)
            gst = graph_file.stat()
            (out_dir / STATE).write_text(json.dumps({"version": VERSION, "files": st, "at": time.time(), "pending_full": 0,
                                                     "graph": [gst.st_size, int(gst.st_mtime_ns // 1_000_000)]}))
        res = {"ok": r.returncode == 0, "mode": "full", "seconds": round(time.time() - t0, 1)}
        print(json.dumps(res) if quiet else f"full graphify update: {'ok' if res['ok'] else 'failed'} in {res['seconds']}s")
        return 0 if res["ok"] else 1
    if not graph_file.exists():
        print("no graphify-out/graph.json here: run `graphify update .` (or --full) once first", file=sys.stderr)
        return 1

    t0 = time.time()
    now = code_files(root)
    state_file = out_dir / STATE
    try:
        state = json.loads(state_file.read_text())
        if state.get("version") != VERSION:
            state = None
    except Exception:
        state = None

    gst = graph_file.stat()
    graph_stamp = [gst.st_size, int(gst.st_mtime_ns // 1_000_000)]
    # fast path: nothing changed since the last sync, and nobody rewrote graph.json since (a full
    # `graphify update` does): answered without reading the graph
    if state and state.get("graph") == graph_stamp:
        before = state.get("files", {})
        if not any(before.get(p) != s for p, s in now.items()) and not any(p not in now for p in before):
            res = {"ok": True, "mode": "incremental", "changed": 0, "removed": 0, "seconds": round(time.time() - t0, 2)}
            print(json.dumps(res) if quiet else f"graphify graph is up to date ({len(now)} code files, {res['seconds']}s)")
            return 0

    graph = json.loads(graph_file.read_text(encoding="utf-8"))
    nodes = graph.get("nodes", [])
    links = graph.get("links", graph.get("edges", []))
    sources = {n.get("source_file") for n in nodes if n.get("source_file")}

    if state:
        before = state.get("files", {})
        changed = [p for p, s in now.items() if before.get(p) != s]
    else:
        # first sync: files edited after the graph was written, and code files the graph doesn't have
        gm = int(graph_file.stat().st_mtime_ns // 1_000_000)
        changed = [p for p, s in now.items() if s[1] > gm or p not in sources]
    # files whose nodes are in the graph but that are gone (or no longer code we track); documents and images
    # that still exist are graphify's semantic layer and stay
    gone = {s for s in sources if s not in now and not (root / s).exists()}
    gone |= {s for s in sources if s in (state or {}).get("files", {}) and s not in now}
    # worktree copies and our own output folders are never part of this checkout's graph
    gone |= {s for s in sources if s.startswith(SKIP_PREFIXES)}
    changed_set = set(changed)
    if not changed_set and not gone:
        state_file.write_text(json.dumps({**(state or {}), "version": VERSION, "files": now, "at": time.time(), "graph": graph_stamp}))
        res = {"ok": True, "mode": "incremental", "changed": 0, "removed": 0, "seconds": round(time.time() - t0, 2)}
        print(json.dumps(res) if quiet else f"graphify graph is up to date ({len(now)} code files, {res['seconds']}s)")
        return 0
    if "--dry-run" in args:
        print(json.dumps({"changed": sorted(changed_set), "removed": sorted(gone)}, indent=1))
        return 0

    from graphify.extract import extract, _safe_extract, _get_extractor, _make_id

    # graphify resolves a file's imports only against the files extracted with it, so the changed files go in
    # with the files they import (per the last graph, and per their import lines now). Those come from
    # graphify's cache, and the import edges come out as a full run makes them.
    import re
    file_of = {n["id"]: n.get("source_file") for n in nodes}
    neighbours = set()
    for e in links:
        if e.get("relation") in ("imports", "imports_from") and e.get("source_file") in changed_set:
            t = file_of.get(e["target"])
            if t in now:
                neighbours.add(t)
    for rel in changed_set:
        try:
            text = (root / rel).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        here = Path(rel).parent
        if rel.endswith(".py"):
            for dots, mod, names in re.findall(r"^\s*from\s+(\.+)([\w.]*)\s+import\s+\(?([\w\s,]+)", text, re.M):
                base = here
                for _ in range(len(dots) - 1):
                    base = base.parent
                stem = base.joinpath(*mod.split(".")) if mod else base
                for cand in [str(stem) + ".py", str(stem / "__init__.py")] + [str(stem / (n.strip() + ".py")) for n in names.split(",") if n.strip()]:
                    if os.path.normpath(cand) in now:
                        neighbours.add(os.path.normpath(cand))
        else:
            for spec in re.findall(r"""(?:from\s+|import\s*\(\s*|require\(\s*)["'](\.{1,2}/[^"']+)["']""", text):
                base = os.path.normpath(str(here / spec))
                for cand in (base, *(base + x for x in (".js", ".ts", ".mjs", ".jsx", ".tsx", "/index.js", "/index.ts"))):
                    if cand in now:
                        neighbours.add(cand)
                        break
    neighbours -= changed_set

    # 1. fresh extraction of the changed files, with their imports as context (graphify's ids, relative paths)
    targets = [root / p for p in sorted(changed_set | neighbours)]
    log(f"graphify sync: re-extracting {len(changed_set)} changed file(s) (+{len(neighbours)} they import, as context), dropping {len(gone)} gone", quiet)
    fresh = extract(targets, cache_root=root) if targets else {"nodes": [], "edges": []}
    for item in fresh["nodes"] + fresh["edges"]:
        sf = item.get("source_file")
        if sf and os.path.isabs(sf):
            try:
                item["source_file"] = str(Path(sf).relative_to(root))
            except ValueError:
                pass

    # 2. splice: out with every node and edge that came from a changed or gone file, in with the fresh ones.
    # The imported files were only context: their nodes and edges in the graph stay as they are.
    from graphify.extract import _source_key
    evict = changed_set | gone
    old_by_id = {n["id"]: n for n in nodes}
    kept = [n for n in nodes if n.get("source_file") not in evict]
    removed_ids = {n["id"] for n in nodes if n.get("source_file") in evict}
    kept_links = [e for e in links if e.get("source_file") not in evict]
    # graphify gives an id a path prefix only when two files produce the same id. Redo that over the whole
    # graph: the changed files can create a collision (or end one) with a file that didn't change.
    def short_of(n):
        sk = _source_key(str(n.get("source_file", "")), root)
        pre = _make_id(sk) + "_" if sk else None
        return (n["id"][len(pre):] if pre and n["id"].startswith(pre) and len(n["id"]) > len(pre) else n["id"]), sk
    fresh_mine = [n for n in fresh["nodes"] if n.get("source_file") in changed_set]
    fresh_key = {n["id"]: short_of(n) for n in fresh["nodes"]}
    groups = defaultdict(set)
    kept_key = {}
    for n in kept:
        kept_key[n["id"]] = short_of(n)
        groups[kept_key[n["id"]][0]].add(kept_key[n["id"]][1])
    for n in fresh_mine:
        groups[fresh_key[n["id"]][0]].add(fresh_key[n["id"]][1])
    final = lambda sh, sk: _make_id(sk, sh) if len(groups[sh]) > 1 and sk else sh
    remap_k = {}
    for n in kept:
        want = final(*kept_key[n["id"]])
        if want != n["id"]:
            remap_k[n["id"]] = want
            n["id"] = want
    remap_f = {}
    for n in fresh["nodes"]:
        sh, sk = fresh_key[n["id"]]
        remap_f[n["id"]] = final(sh, sk) if sh in groups else n["id"]
    for n in fresh_mine:
        n["id"] = remap_f[n["id"]]
    for e in kept_links:
        e["source"] = remap_k.get(e["source"], e["source"])
        e["target"] = remap_k.get(e["target"], e["target"])
    fresh_links = [e for e in fresh["edges"] if e.get("source_file") in changed_set]
    for e in fresh_links:
        for end in ("source", "target"):
            e[end] = remap_f.get(e[end], remap_k.get(e[end], e[end]))
    remap = {"f": remap_f, "k": remap_k}
    kept_ids = {n["id"] for n in kept}
    added = [n for n in fresh_mine if n["id"] not in kept_ids]
    all_nodes = kept + added
    ids = {n["id"] for n in all_nodes}
    pair = lambda e: tuple(sorted((e["source"], e["target"])))
    seen = set()
    new_links = []
    for e in kept_links + fresh_links:
        if e["source"] not in ids or e["target"] not in ids:
            continue
        k = pair(e)
        if k in seen:  # graphify's graph is an undirected simple graph: one edge per pair
            continue
        seen.add(k)
        new_links.append(e)

    # 3. calls from the changed files into the rest of the graph (graphify's unique-name rule)
    label_index = defaultdict(list)
    for n in all_nodes:
        if n.get("file_type") == "rationale":
            continue
        key = str(n.get("label", "")).strip("()").lstrip(".").lower()
        if key:
            label_index[key].append(n["id"])
    file_nid = {n["id"]: _make_id(str(n.get("source_file", ""))) for n in all_nodes if n.get("source_file")}
    sym_imports, mod_imports = defaultdict(set), defaultdict(set)
    for e in new_links:
        if e.get("relation") == "imports":
            sym_imports[e["source"]].add(e["target"])
        elif e.get("relation") == "imports_from":
            mod_imports[e["source"]].add(e["target"])
    resolved = 0
    for p in [root / x for x in sorted(changed_set)]:
        if p.suffix not in (".py", ".js", ".jsx", ".mjs", ".ts", ".tsx", ".vue", ".svelte", ".go", ".java", ".rs", ".rb", ".php", ".cs", ".kt", ".swift"):
            continue
        r = _safe_extract(_get_extractor(p), p)
        for rc in r.get("raw_calls", []):
            if rc.get("is_member_call"):
                continue
            cands = label_index.get(str(rc.get("callee", "")).lower(), [])
            if len(cands) != 1:
                continue
            caller, tgt = rc.get("caller_nid"), cands[0]
            caller = remap["f"].get(caller, caller)
            if caller not in ids:
                caller = _make_id(_source_key(str(p.relative_to(root)), root), caller)
            if caller not in ids or tgt == caller or tuple(sorted((caller, tgt))) in seen:
                continue
            seen.add(tuple(sorted((caller, tgt))))
            evidence = tgt in sym_imports.get(file_nid.get(caller), ()) or file_nid.get(tgt) in mod_imports.get(file_nid.get(caller), ())
            sf = rc.get("source_file", "")
            if sf and os.path.isabs(sf):
                try:
                    sf = str(Path(sf).relative_to(root))
                except ValueError:
                    pass
            new_links.append({"relation": "calls", "context": "call", "confidence": "EXTRACTED" if evidence else "INFERRED",
                              "confidence_score": 1.0 if evidence else 0.8, "source_file": sf,
                              "source_location": rc.get("source_location"), "weight": 1.0, "source": caller, "target": tgt})
            resolved += 1
    # a name that was unique and isn't any more no longer resolves calls from other files (graphify drops them);
    # a name that became unique would gain callers we have no call list for: counted, and left to --full
    lab = lambda n: str(n.get("label", "")).strip("()").lstrip(".").lower()
    before_count = Counter(lab(n) for n in nodes if n.get("file_type") != "rationale")
    after_count = Counter(lab(n) for n in all_nodes if n.get("file_type") != "rationale")
    touched = {lab(n) for n in added} | {lab(old_by_id[i]) for i in removed_ids}
    lost = {k for k in touched if before_count.get(k) == 1 and after_count.get(k, 0) > 1}
    became_unique = sum(1 for k in touched if before_count.get(k, 0) > 1 and after_count.get(k) == 1)
    if lost:
        file_of = {n["id"]: n.get("source_file") for n in all_nodes}
        label_of = {n["id"]: lab(n) for n in all_nodes}
        new_links = [e for e in new_links if not (e.get("relation") == "calls" and label_of.get(e["target"]) in lost
                     and file_of.get(e["source"]) not in evict and file_of.get(e["source"]) != file_of.get(e["target"]))]

    # 4. communities: unchanged nodes keep theirs; new ones follow their neighbours
    comm = {n["id"]: n.get("community") for n in kept}
    for n in added:
        prev = old_by_id.get(n["id"])
        if prev is not None and prev.get("community") is not None:
            comm[n["id"]] = prev["community"]
    nbrs = defaultdict(list)
    for e in new_links:
        nbrs[e["source"]].append(e["target"])
        nbrs[e["target"]].append(e["source"])
    pending = [n["id"] for n in added if comm.get(n["id"]) is None]
    for _ in range(4):
        left = []
        for nid in pending:
            votes = Counter(comm[m] for m in nbrs.get(nid, ()) if comm.get(m) is not None)
            if votes:
                comm[nid] = votes.most_common(1)[0][0]
            else:
                left.append(nid)
        if len(left) == len(pending):
            break
        pending = left
    next_c = max([c for c in comm.values() if isinstance(c, int)] or [0]) + 1
    by_file = {}
    for nid in pending:
        sf = next(n.get("source_file") for n in added if n["id"] == nid)
        if sf not in by_file:
            by_file[sf] = next_c
            next_c += 1
        comm[nid] = by_file[sf]
    try:
        import unicodedata
        strip = lambda s: "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))
    except Exception:
        strip = lambda s: s
    for n in added:
        n["community"] = comm.get(n["id"])
        n["norm_label"] = strip(str(n.get("label", ""))).lower()
    for e in new_links:
        if "confidence_score" not in e:
            e["confidence_score"] = {"EXTRACTED": 1.0, "INFERRED": 0.5, "AMBIGUOUS": 0.2}.get(e.get("confidence", "EXTRACTED"), 1.0)

    # 5. write, atomically, in graphify's shape
    head = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip() or graph.get("built_at_commit")
    graph_out = {k: v for k, v in graph.items() if k not in ("nodes", "links", "edges")}
    graph_out.update({"nodes": all_nodes, "links": new_links, "built_at_commit": head})
    tmp = out_dir / ".graph.sync.tmp.json"
    tmp.write_text(json.dumps(graph_out, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, graph_file)
    pending_full = (state or {}).get("pending_full", 0) + became_unique
    gst = graph_file.stat()
    state_file.write_text(json.dumps({"version": VERSION, "files": now, "at": time.time(), "pending_full": pending_full,
                                      "graph": [gst.st_size, int(gst.st_mtime_ns // 1_000_000)]}))
    res = {"ok": True, "mode": "incremental", "changed": len(changed_set), "removed": len(gone),
           "nodes": {"before": len(nodes), "after": len(all_nodes), "removed": len(removed_ids), "added": len(added)},
           "links": {"before": len(links), "after": len(new_links)}, "crossFileCalls": resolved, "namesBecameUnique": became_unique,
           "seconds": round(time.time() - t0, 1)}
    print(json.dumps(res) if quiet else
          f"graphify sync: {len(changed_set)} changed, {len(gone)} gone file(s); nodes {len(nodes)} -> {len(all_nodes)}, "
          f"links {len(links)} -> {len(new_links)}, {resolved} cross-file call(s) resolved, {res['seconds']}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
