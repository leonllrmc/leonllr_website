#!/usr/bin/env python3
"""Translate a vercel.json routing config into Apache rewrite rules and merge
them into an existing .htaccess (or create one).

The generated rules live between BEGIN/END markers, so re-running replaces only
that block and anything else already in the .htaccess is kept as-is.

Usage:
  vercel-to-htaccess.py <vercel.json> <.htaccess> <url_prefix> <path_prefix>

  url_prefix   public URL of the vercel.json root on the Apache site, e.g. /blog
  path_prefix  path of the vercel.json root relative to the .htaccess folder,
               e.g. "" when the .htaccess sits next to vercel.json, "blog/" when
               it sits in the parent folder

Supported:
  - "routes" (legacy format): src/dest rewrites, status redirects, external
    dest, status-only entries, {"handle": "filesystem"}
  - "rewrites" / "redirects" (current format) with :param, :param* and (.*)
  - "cleanUrls", "trailingSlash" are reported as unsupported (comment + warning)
Anything not understood is written as a comment and printed as a warning,
never silently dropped.
"""
import json
import re
import sys

BEGIN = "# BEGIN routes generated from vercel.json (do not edit, rebuilt on deploy)"
END = "# END routes generated from vercel.json"


def warn(msg, out):
    print(f"warning: {msg}", file=sys.stderr)
    out.append(f"# UNSUPPORTED: {msg}")


def is_external(dest):
    return bool(re.match(r"^[a-z][a-z0-9+.-]*://", dest, re.I))


def local_target(dest, url_prefix):
    """/article.html?x=1 -> /blog/article.html?x=1 (absolute, so no RewriteBase needed)."""
    return url_prefix + dest if dest.startswith("/") else f"{url_prefix}/{dest}"


def pattern(src, path_prefix):
    """Vercel matches src against the full path, implicitly anchored.
    Apache per-directory patterns have no leading slash and are relative to the
    .htaccess folder, hence path_prefix."""
    src = src.strip()
    src = src[1:] if src.startswith("^") else src
    src = src[:-1] if src.endswith("$") and not src.endswith("\\$") else src
    src = src[1:] if src.startswith("/") else src
    return "^" + re.escape(path_prefix).replace("\\/", "/") + src + "$"


def path_to_regex(source):
    """Vercel 'source' syntax (path-to-regexp) -> regex + list of param names."""
    names = []
    out = ""
    i = 0
    tok = re.compile(r":([A-Za-z_][A-Za-z0-9_]*)([*+?])?|\((?!\?)([^)]*)\)|([^:(]+)")
    for m in tok.finditer(source):
        if m.group(1):
            names.append(m.group(1))
            mod = m.group(2)
            if mod in ("*", "+"):
                out += "(.*)" if mod == "*" else "(.+)"
            elif mod == "?":
                out += "([^/]*)"
            else:
                out += "([^/]+)"
        elif m.group(3) is not None:
            names.append(str(len(names)))
            out += f"({m.group(3)})"
        else:
            out += re.sub(r"([.+?^${}|\[\]\\])", r"\\\1", m.group(4))
        i = m.end()
    if i != len(source):
        raise ValueError(f"cannot parse source {source!r}")
    return out, names


def sub_params(dest, names):
    index = {name: idx + 1 for idx, name in enumerate(names)}
    return re.sub(r":([A-Za-z_][A-Za-z0-9_]*)[*+?]?",
                  lambda m: f"${index[m.group(1)]}" if m.group(1) in index else m.group(0), dest)


def rule(src_re, dest, status, url_prefix, after_fs, out, note):
    out.append(f"# {note}")
    if after_fs:
        # Vercel only reaches routes after "handle: filesystem" when no file matched.
        out.append("RewriteCond %{REQUEST_FILENAME} !-f")
        out.append("RewriteCond %{REQUEST_FILENAME} !-d")
    if dest is None:
        # status-only route, e.g. {"src": "/old", "status": 410}
        flag = {403: "F", 410: "G"}.get(status, f"R={status}")
        out.append(f"RewriteRule {src_re} - [{flag},L]")
        return
    target = dest if is_external(dest) else local_target(dest, url_prefix)
    if status and 300 <= status < 400:
        out.append(f"RewriteRule {src_re} {target} [R={status},L,NE]")
    elif is_external(dest):
        # Apache can't proxy without mod_proxy; a redirect is the closest equivalent.
        out.append(f"RewriteRule {src_re} {target} [R=302,L,NE]")
    else:
        # END, not L: in .htaccess [L] re-runs the rules on the rewritten URL, so
        # a route that points at itself (e.g. projects.json) would loop (500).
        out.append(f"RewriteRule {src_re} {target} [END,QSA]")


def convert(cfg, url_prefix, path_prefix):
    out = ["RewriteEngine On"]
    if not path_prefix:
        # Apache redirects /dir to /dir/ before rewrites run, which breaks routes
        # whose URL is also a real folder (/projects/<name>). Vercel doesn't do that,
        # so turn it off here and re-add it below for folders no route handled.
        # (The blog root itself keeps it: rewrites never run for "/blog" without slash.)
        root = url_prefix or "/"
        out.append(f'<If "%{{REQUEST_URI}} != \'{root}\'">')
        out.append("    DirectorySlash Off")
        out.append("</If>")
    error_docs = []

    routes = cfg.get("routes", [])
    after_fs = False
    for r in routes:
        if "handle" in r:
            if r["handle"] == "filesystem":
                after_fs = True
            else:
                warn(f'route handle "{r["handle"]}"', out)
            continue
        src = r.get("src")
        if src is None:
            warn(f"route without src: {json.dumps(r)}", out)
            continue
        extra = set(r) - {"src", "dest", "status", "headers", "continue"}
        if extra:
            warn(f"route keys {sorted(extra)} ignored in {json.dumps(r)}", out)
        if r.get("headers") and not r.get("dest"):
            warn(f"headers-only route {json.dumps(r)}", out)
            continue
        if r.get("headers"):
            warn(f"headers dropped from {json.dumps(r)}", out)
        dest, status = r.get("dest"), r.get("status")
        # A catch-all 4xx/5xx after the filesystem is Vercel's "not found" page.
        if after_fs and status and status >= 400 and src in ("/(.*)", "/.*", "(.*)", ".*"):
            if dest and not path_prefix:
                target = dest if is_external(dest) else local_target(dest, url_prefix)
                error_docs.append(f"ErrorDocument {status} {target}")
            elif dest:
                # .htaccess shared with the rest of the site: an ErrorDocument would
                # apply everywhere, so only send missing paths under the prefix there.
                rule(pattern(src, path_prefix), dest, 302 if is_external(dest) else None,
                     url_prefix, True, out, f"not-found route {json.dumps(r)}")
            continue
        rule(pattern(src, path_prefix), dest, status, url_prefix, after_fs, out, f"route {json.dumps(r)}")

    for rd in cfg.get("redirects", []):
        regex, names = path_to_regex(rd["source"])
        status = rd.get("statusCode") or (308 if rd.get("permanent", True) else 307)
        if rd.get("has") or rd.get("missing"):
            warn(f"has/missing conditions ignored in {json.dumps(rd)}", out)
        rule(pattern(regex, path_prefix), sub_params(rd["destination"], names), status,
             url_prefix, False, out, f"redirect {json.dumps(rd)}")

    for rw in cfg.get("rewrites", []):
        regex, names = path_to_regex(rw["source"])
        if rw.get("has") or rw.get("missing"):
            warn(f"has/missing conditions ignored in {json.dumps(rw)}", out)
        # Vercel applies rewrites only when no static file matches.
        rule(pattern(regex, path_prefix), sub_params(rw["destination"], names), None,
             url_prefix, True, out, f"rewrite {json.dumps(rw)}")

    for key in ("cleanUrls", "trailingSlash", "headers"):
        if key in cfg:
            warn(f'"{key}" setting not translated', out)

    if not path_prefix:
        out.append("# folders not handled by a route keep the usual trailing-slash redirect")
        out.append("RewriteCond %{REQUEST_FILENAME} -d")
        out.append("RewriteCond %{REQUEST_URI} !/$")
        out.append("RewriteRule ^ %{REQUEST_URI}/ [R=301,L]")
    return out + error_docs


def merge(htaccess_path, block):
    try:
        with open(htaccess_path, encoding="utf-8") as f:
            current = f.read()
    except FileNotFoundError:
        current = ""
    # drop a previously generated block, keep everything else
    current = re.sub(
        re.escape(BEGIN) + r".*?" + re.escape(END) + r"\n?", "", current, flags=re.S
    ).rstrip("\n")
    generated = "\n".join([BEGIN, *block, END]) + "\n"
    merged = (current + "\n\n" + generated) if current else generated
    with open(htaccess_path, "w", encoding="utf-8") as f:
        f.write(merged)
    return bool(current)


def main():
    if len(sys.argv) != 5:
        sys.exit(__doc__)
    vercel_json, htaccess, url_prefix, path_prefix = sys.argv[1:]
    url_prefix = "/" + url_prefix.strip("/") if url_prefix.strip("/") else ""
    path_prefix = path_prefix.strip("/") + "/" if path_prefix.strip("/") else ""
    with open(vercel_json, encoding="utf-8") as f:
        cfg = json.load(f)
    block = convert(cfg, url_prefix, path_prefix)
    kept = merge(htaccess, block)
    print(f"{htaccess}: {sum(l.startswith('RewriteRule') for l in block)} rules from "
          f"{vercel_json}" + (" merged into existing file" if kept else " (new file)"))


if __name__ == "__main__":
    main()
