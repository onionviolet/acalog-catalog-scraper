const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const metadata = `// ==UserScript==
// @name         Modern Campus Catalog Export
// @namespace    https://github.com/onionviolet/acalog-catalog-scraper
// @version      3.0.0
// @description  Export complete Modern Campus catalogs to Markdown, JSON, per-department files, and diffs.
// @match        https://catalog.wlu.edu/content.php*
// @grant        none
// ==/UserScript==
`;
const output = [
  metadata,
  fs.readFileSync(path.join(root, "src", "catalog-core.js"), "utf8"),
  fs.readFileSync(path.join(root, "src", "browser.js"), "utf8"),
].join("\n");

const destination = path.join(root, "dist", "acalog-catalog-export.user.js");
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, output);
console.log(`built ${path.relative(root, destination)}`);
