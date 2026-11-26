#!/usr/bin/env node
// Builds the llrblog sources into a fully static website.
//
// The blog normally renders itself in the browser: main.js / project.js /
// article.js fetch the JSON metadata and markdown and showdown converts it.
// This script does the same work ahead of time, so every page is plain HTML:
//
//   index.html                                  project list
//   projects/<project>/index.html               project page + article cards
//   projects/<project>/article/<article>/index.html   rendered article
//
// Those are the same pretty URLs vercel.json routes to the dynamic pages, so no
// rewrite rules are needed on the host. Every other file (css, images, json,
// md, rss, sitemap...) is copied as-is.
//
// Markdown goes through showdown 2.1.0 with default options, exactly like the
// browser, so the output matches what visitors saw before.
//
// Each generated page also gets the <head> tags link previews are made from
// (Open Graph, Twitter card, description, canonical URL). Articles use their
// top_background as the preview image, projects their thumbnail.
// With --site-url, sitemap.xml is generated from those pages (lastmod = newest
// publish_date) and the Sitemap line of robots.txt points to it.
//
// Usage: node build-blog.mjs <blog_dir> <out_dir> [--base /blog] [--site-url https://example.com]
//   --base       URL prefix the site is served under ("" when served at the root).
//                Only used for the links this script generates itself; the links
//                in the sources are expected to be prefixed already
//                (see rewrite-image-links.sh).
//   --site-url   public origin of the site, used for the absolute URLs social
//                media needs (og:url, canonical, local preview images). Without
//                it those tags are left out and only absolute images are used.
import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import showdown from "showdown";

function usage(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error("usage: node build-blog.mjs <blog_dir> <out_dir> [--base /blog] [--site-url https://example.com]");
  process.exit(2);
}

const args = process.argv.slice(2);
const options = { base: "", "site-url": "" };
const positional = [];
for (let i = 0; i < args.length; i++) {
  const m = args[i].match(/^--([a-z-]+)(?:=(.*))?$/);
  if (!m) positional.push(args[i]);
  else if (!(m[1] in options)) usage(`unknown option --${m[1]}`);
  else options[m[1]] = m[2] ?? args[++i] ?? usage(`--${m[1]} needs a value`);
}
if (positional.length !== 2) usage();
const [srcDir, outDir] = positional.map((p) => path.resolve(p));
let base = options.base.replace(/^\/*/, "/").replace(/\/+$/, "");
if (base === "/") base = "";
const siteUrl = options["site-url"].replace(/\/+$/, "");
if (siteUrl && !/^https?:\/\/[^/]+$/i.test(siteUrl)) usage("--site-url must be an origin like https://example.com");

{
  const rel = path.relative(srcDir, outDir);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) usage("out_dir must be outside blog_dir");
}

// Files that only matter for the source repo / Vercel, never for the static site.
// vercel.json is dropped on purpose: its routes point the pretty URLs back at
// the dynamic article.html / project.html.
const SKIP = new Set([".git", ".github", ".gitignore", ".gitmodules", ".vercel", "vercel.json", "node_modules"]);

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`cannot read ${path.relative(srcDir, file)}: ${err.message}`);
  }
};
const readTemplate = (name) => cheerio.load(fs.readFileSync(path.join(srcDir, name), "utf8"));
const write = (rel, content) => {
  const file = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

// Same rules as the blog JS for thumbnail / top_background values.
function imageUrl(value, projectName) {
  if (value === "placeholder") return "https://picsum.photos/200";
  if (value === "none") return `${base}/none.png`;
  if (value.startsWith("http")) return value;
  return `${base}/projects/${projectName}${value}`;
}

// "dd/mm/yyyy hh:mm" -> "dd/mm/yyyy", the way project.js / article.js display it.
function displayDate(publishDate) {
  const match = String(publishDate).match(/\d+\/\d+\/\d+/);
  if (!match) throw new Error(`bad publish_date ${JSON.stringify(publishDate)}`);
  const [d, m, y] = match[0].split("/").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("fr-FR");
}

// "04/07/2026 13:44" -> "2026-07-04T13:44:00+02:00" (dates are written in Swiss time)
function isoDate(publishDate) {
  const m = String(publishDate).match(/(\d+)\/(\d+)\/(\d+)(?:\s+(\d+):(\d+))?/);
  if (!m) return undefined;
  const [, d, mo, y, h = "0", mi = "0"] = m;
  const pad = (n) => String(n).padStart(2, "0");
  const local = `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:00`;
  // offset of Europe/Zurich at that moment (CET/CEST)
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Zurich", timeZoneName: "longOffset" })
    .formatToParts(new Date(`${local}Z`)).find((p) => p.type === "timeZoneName").value.replace("GMT", "");
  return local + (offset || "+00:00");
}

const plainText = (html) => cheerio.load(`<body>${html ?? ""}</body>`)("body").text().replace(/\s+/g, " ").trim();
const absolute = (url) => (/^https?:\/\//i.test(url) ? url : siteUrl && url.startsWith("/") ? siteUrl + url : undefined);

// Link-preview tags (Open Graph for Facebook/Discord/LinkedIn/..., Twitter card),
// replacing any the template already has, right after <title>.
function addSocialTags($, { type, title, description, path: pagePath, image, imageAlt, published }) {
  const pageUrl = siteUrl ? siteUrl + base + pagePath : undefined;
  const img = image && absolute(image);
  const desc = plainText(description);
  $('meta[property^="og:"], meta[property^="article:"], meta[name^="twitter:"], meta[name="description"], link[rel="canonical"]').remove();

  const tags = [];
  const meta = (attr, key, content) => {
    if (content) tags.push($("<meta>").attr(attr, key).attr("content", content));
  };
  meta("name", "description", desc);
  if (pageUrl) tags.push($("<link>").attr("rel", "canonical").attr("href", pageUrl));
  meta("property", "og:site_name", "llrblog");
  meta("property", "og:type", type);
  meta("property", "og:title", title);
  meta("property", "og:description", desc);
  meta("property", "og:url", pageUrl);
  meta("property", "og:image", img);
  meta("property", "og:image:alt", img && imageAlt);
  meta("property", "article:published_time", type === "article" ? isoDate(published) : undefined);
  meta("property", "article:author", type === "article" ? "leonllrmc" : undefined);
  meta("name", "twitter:card", img && type === "article" ? "summary_large_image" : "summary");
  meta("name", "twitter:title", title);
  meta("name", "twitter:description", desc);
  meta("name", "twitter:image", img);
  meta("name", "twitter:image:alt", img && imageAlt);

  const anchor = $("head > title").first();
  const indent = "\n   ";
  const html = tags.map((t) => $.html(t)).join(indent);
  if (anchor.length) anchor.after(indent + html);
  else $("head").prepend(indent + html);
  if (!img && image) warnings.push(`${pagePath}: preview image ${image} is not absolute (use --site-url), left out`);
}

// The scripts that render the page in the browser are replaced by the
// pre-rendered markup, so they are dropped from the generated pages.
function dropClientRenderer($, ...files) {
  $("script[src]").each((_, el) => {
    const file = $(el).attr("src").split(/[?#]/)[0].split("/").pop();
    if (files.includes(file)) $(el).remove();
  });
}

// 1) copy everything
fs.rmSync(outDir, { recursive: true, force: true });
fs.cpSync(srcDir, outDir, {
  recursive: true,
  filter: (src) => !SKIP.has(path.basename(src)),
});

// vercel.json mapped /favicon.ico to the logo.
if (fs.existsSync(path.join(srcDir, "logo.webp")) && !fs.existsSync(path.join(srcDir, "favicon.ico"))) {
  fs.copyFileSync(path.join(srcDir, "logo.webp"), path.join(outDir, "favicon.ico"));
}

// vercel.json's catch-all route after the filesystem is the "not found" page
// (https://http.cat/404). Keep it on Apache hosts through .htaccess, which only
// applies to this folder; other hosts ignore the file.
{
  const vercelJson = path.join(srcDir, "vercel.json");
  const routes = fs.existsSync(vercelJson) ? readJson(vercelJson).routes ?? [] : [];
  const afterFs = routes.slice(routes.findIndex((r) => r.handle === "filesystem") + 1);
  const notFound = routes.some((r) => r.handle === "filesystem") &&
    afterFs.find((r) => r.status === 404 && r.dest && ["/(.*)", "/.*", "(.*)", ".*"].includes(r.src));
  const htaccess = path.join(outDir, ".htaccess");
  const current = fs.existsSync(htaccess) ? fs.readFileSync(htaccess, "utf8") : "";
  if (notFound && !/^\s*ErrorDocument\s+404\b/m.test(current)) {
    const dest = /^[a-z][a-z0-9+.-]*:\/\//i.test(notFound.dest) ? notFound.dest : base + notFound.dest;
    fs.writeFileSync(htaccess, (current ? current.replace(/\n*$/, "\n\n") : "") + `ErrorDocument 404 ${dest}\n`);
  }
}

// 2) load metadata
const projectNames = readJson(path.join(srcDir, "projects/projects.json")).projects;
const projects = projectNames.map((name) => {
  const dir = path.join(srcDir, "projects", name);
  return {
    name,
    meta: readJson(path.join(dir, "project.json")),
    articles: readJson(path.join(dir, "articles/articles.json")).articles_metadata ?? {},
  };
});

const markdown = new showdown.Converter();
let pageCount = 0;
const warnings = [];
const sitemap = []; // { path, lastmod }

// "dd/mm/yyyy ..." -> "yyyy-mm-dd" for the sitemap
const day = (publishDate) => isoDate(publishDate)?.slice(0, 10);
const latest = (dates) => dates.filter(Boolean).sort().at(-1);
const projectLastmod = (articles) => latest(Object.values(articles).map((a) => day(a.publish_date)));

// 3) home page
{
  const $ = readTemplate("index.html");
  let html = "";
  for (const { name, meta, articles } of projects) {
    const { title, thumbnail, description } = meta;
    html += `
      <div class="row" id="project-${name}">
         <div class="col s12 m6">
            <div class="card card-project blue-grey darken-1" onclick="window.location.assign('${base}/projects/${name}')">
               <div class="card-content white-text">
                  <span class="card-title"><img src="${imageUrl(thumbnail, name)}" class="project-logo"> ${title}</span>
                  <p>${description}</p>
               </div>

               <div class="card-action">
                  <small>Article count: ${Object.keys(articles).length}</small>
               </div>
            </div>
         </div>
      </div>`;
  }
  $("#project-list").html(html);
  dropClientRenderer($, "main.js");
  addSocialTags($, {
    type: "website",
    title: "llrblog",
    description: `leonllrmc's project blog. Projects: ${projects.map((p) => plainText(p.meta.title)).join(", ")}`,
    path: "/",
    image: $("img.img-logo").first().attr("src"),
    imageAlt: "llrblog logo",
  });
  write("index.html", $.html());
  sitemap.push({ path: "/", lastmod: latest(projects.map((p) => projectLastmod(p.articles))) });
  pageCount++;
}

// 4) project pages + article pages
for (const { name, meta, articles } of projects) {
  const { title, thumbnail, description } = meta;

  const $p = readTemplate("project.html");
  $p("title").text(`${name} project (llrblog)`);
  $p("#project-infos").html(`
      <span><img src="${imageUrl(thumbnail, name)}" style="float: left;" class="project-img-big" alt="">
      <div style="float: left;"><h2>${title}</h2>
      <h4 style="white-space: pre-wrap;">${description}</h4></span></div>`);

  let cards = "";
  for (const articleName of Object.keys(articles).reverse()) { // latest first
    const article = articles[articleName];
    cards += `
            <div class="col s4 m2" id="article-${name}">
               <div class="card card-article blue-grey darken-1" onclick="window.location.assign('${base}/projects/${name}/article/${articleName}')">
                  <div class="card-image">
                     <img src="${imageUrl(article.top_background, name)}">
                     <span class="card-title article-card-title">${article.title}</span>
                  </div>
                  <div class="card-content">
                     <small>${article.description}</small>
                  </div>
                  <div class="card-action">
                     <small>Release date: ${displayDate(article.publish_date)}</small>
                  </div>
               </div>
            </div>`;
  }
  $p("#articles-list").html(cards);
  dropClientRenderer($p, "project.js");
  addSocialTags($p, {
    type: "website",
    title: plainText(title),
    description,
    path: `/projects/${name}/`,
    image: imageUrl(thumbnail, name),
    imageAlt: plainText(title),
  });
  write(`projects/${name}/index.html`, $p.html());
  sitemap.push({ path: `/projects/${name}/`, lastmod: projectLastmod(articles) });
  pageCount++;

  for (const [articleName, article] of Object.entries(articles)) {
    const mdFile = path.join(srcDir, "projects", name, "articles", `${articleName}.md`);
    if (!fs.existsSync(mdFile)) {
      // the dynamic page sent visitors to a 404 in that case, so does the static site
      warnings.push(`projects/${name}/articles/${articleName}.md is missing, article skipped`);
      continue;
    }

    const $a = readTemplate("article.html");
    $a("title").text(`${articleName} article (llrblog)`);
    $a("#article-infos").html(`
   <span><img src="${imageUrl(article.top_background, name)}" class="article-top-background" alt="">
   <div style="text-align: center;"><h2>${article.title}</h2>
   <h4 style="white-space: pre-wrap;">${article.description}</h4></span>
   <p>Release date: ${displayDate(article.publish_date)}</p></div>
   <hr class="article-top-hr1">
   `);
    $a("#article-markdown").html(markdown.makeHtml(fs.readFileSync(mdFile, "utf8")));

    // Comments: the template holds ${articleName} / ${title} placeholders that an
    // inline script filled in after fetching articles.json. Fill them now and keep
    // only the part of that script that loads cusdis.
    const thread = $a("#cusdis_thread");
    for (const attr of ["data-page-id", "data-page-url", "data-page-title"]) {
      const value = thread.attr(attr);
      if (value !== undefined) {
        thread.attr(attr, value
          .replaceAll("${articleName}", articleName)
          .replaceAll("${projectName}", name)
          .replaceAll("${title}", article.title));
      }
    }
    $a("script:not([src])").each((_, el) => {
      if ($a(el).text().includes("cusdis_thread")) {
        $a(el).text(`
      (() => {
         let cusdis_script = document.createElement("script");
         cusdis_script.src = "https://cusdis.com/js/cusdis.es.js";
         cusdis_script.addEventListener("load", () => window.CUSDIS.setTheme('dark'));
         document.head.appendChild(cusdis_script);
      })();
   `);
      }
    });

    dropClientRenderer($a, "article.js", "showdown.min.js");
    // article.js initialised the image carousels once the markdown was in place
    $a("body").append(`
   <script>
      document.addEventListener("DOMContentLoaded", () => M.Carousel.init(document.querySelectorAll('.carousel'), { numVisible: 1 }));
   </script>
`);
    addSocialTags($a, {
      type: "article",
      title: plainText(article.title),
      description: article.description,
      path: `/projects/${name}/article/${articleName}/`,
      image: imageUrl(article.top_background, name),
      imageAlt: plainText(article.title),
      published: article.publish_date,
    });
    write(`projects/${name}/article/${articleName}/index.html`, $a.html());
    sitemap.push({ path: `/projects/${name}/article/${articleName}/`, lastmod: day(article.publish_date) });
    pageCount++;
  }
}

// 5) sitemap.xml generated from the pages above (replaces the hand-written one),
//    and robots.txt pointed at it
if (siteUrl) {
  const xmlEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const urls = sitemap.map(({ path: p, lastmod }) =>
    `  <url>\n    <loc>${xmlEscape(siteUrl + base + p)}</loc>\n` +
    (lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : "") +
    `  </url>`);
  write("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`);

  const robots = path.join(outDir, "robots.txt");
  const sitemapLine = `Sitemap: ${siteUrl}${base}/sitemap.xml`;
  const current = fs.existsSync(robots) ? fs.readFileSync(robots, "utf8") : "User-agent: *\nDisallow:\n";
  fs.writeFileSync(robots, /^Sitemap:.*$/im.test(current)
    ? current.replace(/^Sitemap:.*$/gim, sitemapLine)
    : current.replace(/\n*$/, `\n\n${sitemapLine}\n`));
} else {
  warnings.push("no --site-url, sitemap.xml copied as-is instead of generated");
}

for (const w of warnings) console.warn(`warning: ${w}`);
console.log(`Built ${pageCount} pages from ${path.relative(process.cwd(), srcDir) || "."} into ` +
  `${path.relative(process.cwd(), outDir) || "."} (base "${base || "/"}")`);
