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
// Usage: node build-blog.mjs <blog_dir> <out_dir> [--base /blog]
//   --base   URL prefix the site is served under ("" when served at the root).
//            Only used for the links this script generates itself; the links
//            in the sources are expected to be prefixed already
//            (see rewrite-image-links.sh).
import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import showdown from "showdown";

function usage(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error("usage: node build-blog.mjs <blog_dir> <out_dir> [--base /blog]");
  process.exit(2);
}

const args = process.argv.slice(2);
let base = "";
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--base") base = args[++i] ?? usage("--base needs a value");
  else if (args[i].startsWith("--base=")) base = args[i].slice("--base=".length);
  else positional.push(args[i]);
}
if (positional.length !== 2) usage();
const [srcDir, outDir] = positional.map((p) => path.resolve(p));
base = base.replace(/^\/*/, "/").replace(/\/+$/, "");
if (base === "/") base = "";

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
  write("index.html", $.html());
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
  write(`projects/${name}/index.html`, $p.html());
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
    write(`projects/${name}/article/${articleName}/index.html`, $a.html());
    pageCount++;
  }
}

for (const w of warnings) console.warn(`warning: ${w}`);
console.log(`Built ${pageCount} pages from ${path.relative(process.cwd(), srcDir) || "."} into ` +
  `${path.relative(process.cwd(), outDir) || "."} (base "${base || "/"}")`);
