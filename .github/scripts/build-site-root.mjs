#!/usr/bin/env node
// Adds the main site (every file of this repo outside the blog submodule) to the
// built site, next to the blog that build-blog.mjs already wrote there.
//
//   - copies every tracked file, at any depth (root files and all folders,
//     including ones added later), except .github/, .git* files and submodules
//     (the blog is built separately into <out_dir>/blog)
//   - sitemap-main.xml: the main site's own pages (*.html), lastmod = date of
//     the last commit that touched the file
//   - sitemap.xml: sitemap index listing sitemap-main.xml and the sitemap.xml
//     of each sub-site (e.g. blog/sitemap.xml)
//   - robots.txt: the repo's robots.txt with its Sitemap lines replaced by one
//     pointing to that index (a default one when the repo has none)
//
// The repo's own sitemap.xml, if any, is not copied: the index replaces it.
//
// Run it from inside the repo (it uses git), after build-blog.mjs.
// Usage: node build-site-root.mjs <out_dir> --site-url https://example.com
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function usage(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error("usage: node build-site-root.mjs <out_dir> --site-url https://example.com");
  process.exit(2);
}

const args = process.argv.slice(2);
let siteUrl = "";
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--site-url") siteUrl = args[++i] ?? usage("--site-url needs a value");
  else if (args[i].startsWith("--site-url=")) siteUrl = args[i].slice("--site-url=".length);
  else positional.push(args[i]);
}
if (positional.length !== 1) usage();
siteUrl = siteUrl.replace(/\/+$/, "");
if (!/^https?:\/\/[^/]+$/i.test(siteUrl)) usage("--site-url must be an origin like https://example.com");
const outDir = path.resolve(positional[0]);

const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

const GENERATED = new Set(["sitemap.xml", "sitemap-main.xml", "robots.txt"]);
const xmlEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const latest = (dates) => dates.filter(Boolean).sort().at(-1);

// 1) copy the main site
const copied = [];
const submodules = [];
for (const entry of git("ls-files", "-s", "-z").split("\0").filter(Boolean)) {
  const [info, file] = entry.split("\t");
  if (info.startsWith("160000 ")) { // submodule: built by its own step (the blog), not copied
    submodules.push(file);
    continue;
  }
  if (file.split("/").some((part) => part.startsWith(".git"))) continue; // .github/, .gitignore, .gitmodules
  if (GENERATED.has(file)) continue;
  const dest = path.join(outDir, file);
  if (fs.existsSync(dest)) throw new Error(`${file} would overwrite a built file`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(repo, file), dest);
  copied.push(file);
}

// 2) sitemap of the main site's pages
const pages = copied
  .filter((f) => f.endsWith(".html") && !/(^|\/)(404|50\d)\.html$/.test(f))
  .map((f) => ({
    url: siteUrl + "/" + f.replace(/(^|\/)index\.html$/, "$1"),
    // needs the full history (checkout fetch-depth: 0), else every file gets the HEAD date
    lastmod: git("log", "-1", "--format=%cs", "--", f).trim() || undefined,
  }))
  .sort((a, b) => a.url.localeCompare(b.url));
const urlset = (urls) => `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.map(({ url, lastmod }) => `  <url>\n    <loc>${xmlEscape(url)}</loc>\n` +
    (lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : "") + `  </url>`).join("\n") +
  `\n</urlset>\n`;
fs.writeFileSync(path.join(outDir, "sitemap-main.xml"), urlset(pages));

// 3) sitemap index: main pages + every sub-site's sitemap.xml
const sitemaps = [{ url: `${siteUrl}/sitemap-main.xml`, lastmod: latest(pages.map((p) => p.lastmod)) }];
for (const dir of fs.readdirSync(outDir, { withFileTypes: true })) {
  const sub = path.join(outDir, dir.name, "sitemap.xml");
  if (!dir.isDirectory() || !fs.existsSync(sub)) continue;
  const dates = [...fs.readFileSync(sub, "utf8").matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1].slice(0, 10));
  sitemaps.push({ url: `${siteUrl}/${dir.name}/sitemap.xml`, lastmod: latest(dates) });
}
fs.writeFileSync(path.join(outDir, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  sitemaps.map(({ url, lastmod }) => `  <sitemap>\n    <loc>${xmlEscape(url)}</loc>\n` +
    (lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : "") + `  </sitemap>`).join("\n") +
  `\n</sitemapindex>\n`);

// 4) robots.txt: keep the repo's rules, point to the index
const robotsSrc = path.join(repo, "robots.txt");
const rules = (fs.existsSync(robotsSrc) ? fs.readFileSync(robotsSrc, "utf8") : "User-agent: *\nDisallow:\n")
  .split(/\r?\n/)
  // Sitemap lines, and bare indented URLs continuing one (not valid robots.txt)
  .filter((line) => !/^\s*sitemap\s*:/i.test(line) && !/^\s+https?:\/\/\S+\s*$/.test(line))
  .join("\n").replace(/\s+$/, "");
fs.writeFileSync(path.join(outDir, "robots.txt"), `${rules}\n\nSitemap: ${siteUrl}/sitemap.xml\n`);

console.log(`Main site: ${copied.length} files copied, ${pages.length} pages in sitemap-main.xml, ` +
  `${sitemaps.length} sitemaps in sitemap.xml`);
const folders = [...new Set(copied.filter((f) => f.includes("/")).map((f) => f.split("/")[0]))];
if (folders.length) console.log(`  folders: ${folders.join(", ")}`);
for (const s of submodules) {
  const built = fs.existsSync(path.join(outDir, s));
  console.log(`  submodule ${s}: not copied${built ? " (built separately)" : " (WARNING: nothing built for it, it is not deployed)"}`);
}
