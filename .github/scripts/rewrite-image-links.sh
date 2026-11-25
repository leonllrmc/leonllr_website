#!/usr/bin/env bash
# Rewrites root-relative image links inside the `blog` submodule so they point
# to the Vercel deployment. Works on the checked-out copy only (never committed).
set -euo pipefail

BLOG_DIR="${1:-blog}"
BASE_URL="${2:-https://llrblog.vercel.app}"
BASE_URL="${BASE_URL%/}"
export BASE_URL

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