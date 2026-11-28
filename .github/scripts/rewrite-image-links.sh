#!/usr/bin/env bash
# Prepares the `blog` submodule for hosting under a sub-folder (/blog/) of the
# main site:
#   - image links point to the Vercel deployment (steps 1-3)
#   - every other root-relative path gets the sub-folder prefix (step 4)
#   - the vercel.json routes are translated and merged into .htaccess (step 5,
#     skipped with SKIP_ROUTING=1)
# Works on the checked-out copy only (never committed). Safe to run twice.
#
# Usage: rewrite-image-links.sh [blog_dir] [vercel_url] [site_prefix]
set -euo pipefail

BLOG_DIR="${1:-blog}"
BASE_URL="${2:-https://llrblog.vercel.app}"
BASE_URL="${BASE_URL%/}"
SITE_PREFIX="${3:-/$(basename "$BLOG_DIR")}"
SITE_PREFIX="/${SITE_PREFIX#/}"; SITE_PREFIX="${SITE_PREFIX%/}"
export BASE_URL SITE_PREFIX

# 1) Markdown articles: ![alt](/projects/<name>/img/x.png), <img src="...">, <video src="...">
#    The leading quote/paren requirement makes this idempotent (already-absolute URLs are skipped).
find "$BLOG_DIR/projects" -type f -name '*.md' -print0 |
  xargs -0 -r perl -pi -e \
    's{(["\x27(])/projects/([^/"\x27)\s]+)/img/}{$1$ENV{BASE_URL}/projects/$2/img/}g'

# 2) JSON metadata: "thumbnail" / "top_background": "/img/x.png"
#    The blog JS prefixes /projects/<name> unless the value starts with "http",
#    so the project name is baked into the absolute URL here.
#    "placeholder" and "none" are left untouched.
for dir in "$BLOG_DIR"/projects/*/; do
  name="$(basename "$dir")"
  export PROJECT_NAME="$name"
  find "$dir" -type f -name '*.json' -print0 |
    xargs -0 -r perl -pi -e \
      's{("(?:thumbnail|top_background)"\s*:\s*")/img/}{$1$ENV{BASE_URL}/projects/$ENV{PROJECT_NAME}/img/}g'
done

# 3) Site chrome in the blog root (logo, default background)
find "$BLOG_DIR" -maxdepth 1 -type f \( -name '*.html' -o -name '*.js' \) -print0 |
  xargs -0 -r perl -pi -e \
    's{(["\x27(])/(logo\.webp|none\.png)}{$1$ENV{BASE_URL}/$2}g'

echo "Image links rewritten to $BASE_URL"

# 4) Every remaining root-relative path -> $SITE_PREFIX/...
#    Only paths inside quotes/backticks (and markdown "(" links) are touched, so
#    protocol-relative URLs (//cdn...), regex literals like .match(/\/projects\/...)
#    and split("/") stay as they are. Paths that already start with the prefix are
#    skipped, which keeps the step idempotent.
PREFIX_NAME="${SITE_PREFIX#/}"
export PREFIX_NAME
#    4a) root HTML / JS / CSS: href="/", "/style.css", `/projects/${name}`, '/none.png'...
find "$BLOG_DIR" -maxdepth 1 -type f \( -name '*.html' -o -name '*.js' -o -name '*.css' \) -print0 |
  xargs -0 -r perl -pi -e '
    s{((?:href|src|action)\s*=\s*["\x27])/(?=["\x27])}{$1$ENV{SITE_PREFIX}/}g;
    s{(["\x27`])/(?!\Q$ENV{PREFIX_NAME}\E/)(?=[A-Za-z0-9_.\$])}{$1$ENV{SITE_PREFIX}/}g;
    s{url\(\s*(["\x27]?)/(?!/)(?!\Q$ENV{PREFIX_NAME}\E/)}{url($1$ENV{SITE_PREFIX}/}g;
  '
#    4b) markdown articles: [text](/projects/...), href="/...", src="/..."
find "$BLOG_DIR/projects" -type f -name '*.md' -print0 |
  xargs -0 -r perl -pi -e \
    's{(["\x27(])/(?!\Q$ENV{PREFIX_NAME}\E/)(?=[A-Za-z0-9_.])}{$1$ENV{SITE_PREFIX}/}g'

# 5) Routing. Vercel applies $BLOG_DIR/vercel.json (pretty URLs such as
#    /projects/<p>/article/<a> -> article.html); Apache (Infomaniak) needs the same
#    as .htaccess rules. They are translated from vercel.json and merged into the
#    existing .htaccess (HTACCESS env var, default $BLOG_DIR/.htaccess) inside a
#    marked block, so rules already in that file are kept.
#    SKIP_ROUTING=1 skips this step: the static build (build-blog.mjs) writes real
#    pages at those URLs, and these rules would send them back to article.html.
HTACCESS="${HTACCESS:-$BLOG_DIR/.htaccess}"
if [ "${SKIP_ROUTING:-0}" = 1 ]; then
  echo "SKIP_ROUTING=1, vercel.json routes not translated"
elif [ -f "$BLOG_DIR/vercel.json" ]; then
  # path of the blog folder relative to the .htaccess folder ("" or "blog/")
  REL="$(realpath --relative-to="$(dirname "$HTACCESS")" "$BLOG_DIR")"
  [ "$REL" = "." ] && REL=""
  python3 "$(dirname "$0")/vercel-to-htaccess.py" \
    "$BLOG_DIR/vercel.json" "$HTACCESS" "$SITE_PREFIX" "$REL"
else
  echo "No $BLOG_DIR/vercel.json, routing left untouched"
fi

echo "Site paths prefixed with $SITE_PREFIX/"

echo "rewiting sitemap url"
sed -i -e 's/llrblog.vercel.com/leonllr.ch\/blog/g' $BLOG_DIR/sitemap.xml