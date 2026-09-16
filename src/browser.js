(function () {
  "use strict";

  const core = window.AcalogCatalogCore;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const STORAGE_KEY = "acalog-catalog-export:last-snapshot";
  const MAX_RETRIES = 6;

  function save(name, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function tarOctal(value, width) {
    return `${value.toString(8).padStart(width - 1, "0")}\0`;
  }

  function createTar(files) {
    const encoder = new TextEncoder();
    const chunks = [];
    for (const [name, content] of Object.entries(files)) {
      const body = encoder.encode(content);
      const header = new Uint8Array(512);
      const write = (value, offset, length) => header.set(encoder.encode(value).slice(0, length), offset);
      write(name, 0, 100);
      write(tarOctal(0o644, 8), 100, 8);
      write(tarOctal(0, 8), 108, 8);
      write(tarOctal(0, 8), 116, 8);
      write(tarOctal(body.length, 12), 124, 12);
      write(tarOctal(Math.floor(Date.now() / 1000), 12), 136, 12);
      write("        ", 148, 8);
      write("0", 156, 1);
      write("ustar\0", 257, 6);
      write("00", 263, 2);
      const checksum = header.reduce((sum, byte) => sum + byte, 0);
      write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
      chunks.push(header, body);
      const padding = (512 - (body.length % 512)) % 512;
      if (padding) chunks.push(new Uint8Array(padding));
    }
    chunks.push(new Uint8Array(1024));
    return new Blob(chunks, { type: "application/x-tar" });
  }

  function pageUrl(page) {
    const url = new URL(location.href);
    url.searchParams.set("expand", "1");
    url.searchParams.set("print", "1");
    url.searchParams.set("filter[cpage]", String(page));
    return url;
  }

  async function fetchPage(page, say) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      let response;
      let html = "";
      try {
        response = await fetch(pageUrl(page), { credentials: "same-origin" });
        html = await response.text();
      } catch (error) {
        console.warn(`Catalog page ${page} request failed`, error);
      }
      if (response?.ok && html.length > 300) return html;
      const wait = 2000 * attempt;
      say(`Page ${page} returned ${response?.status || "a network error"}. Retrying in ${wait / 1000}s.`);
      await sleep(wait);
    }
    throw new Error(`Catalog page ${page} stayed empty or throttled after ${MAX_RETRIES} attempts.`);
  }

  function catalogText(doc) {
    const main = doc.querySelector("td.block_content") || doc.querySelector("main") || doc.body;
    const copy = main.cloneNode(true);
    copy.querySelectorAll("form, table.nounderlines, script, style, nav").forEach((node) => node.remove());
    copy.querySelectorAll('a[href*="preview_course"]').forEach((anchor) => anchor.replaceWith(anchor.textContent));
    return (copy.innerText || copy.textContent || "")
      .replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  }

  function expectedPages(doc) {
    const pages = [...doc.querySelectorAll('a[href*="filter%5Bcpage%5D"], a[href*="filter[cpage]"]')]
      .map((anchor) => {
        const url = new URL(anchor.href, location.href);
        return Number(url.searchParams.get("filter[cpage]"));
      }).filter(Number.isFinite);
    return Math.max(1, ...pages);
  }

  function parseDepartments(value) {
    const departments = String(value || "").split(",")
      .map((item) => item.trim().toUpperCase()).filter(Boolean);
    const invalid = departments.filter((item) => !/^[A-Z]{2,5}$/.test(item));
    if (invalid.length) throw new Error(`Invalid department prefixes: ${invalid.join(", ")}`);
    return [...new Set(departments)].sort();
  }

  async function run(options = {}) {
    const departments = options.departments || [];
    const banner = document.createElement("div");
    banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:100000;background:#111;color:#7CFC00;padding:10px;font:14px monospace";
    document.body.appendChild(banner);
    const say = (message) => { banner.textContent = message; console.info(message); };

    try {
      say("Catalog export: checking pagination.");
      const firstHtml = await fetchPage(1, say);
      const firstDoc = new DOMParser().parseFromString(firstHtml, "text/html");
      const pageCount = expectedPages(firstDoc);
      const chunks = [];
      for (let page = 1; page <= pageCount; page += 1) {
        const doc = page === 1 ? firstDoc
          : new DOMParser().parseFromString(await fetchPage(page, say), "text/html");
        const text = catalogText(doc);
        const count = core.parseCourseText(text).length;
        if (!count) throw new Error(`Catalog page ${page}/${pageCount} contained no course records. No output was saved.`);
        chunks.push(text);
        say(`Catalog export: page ${page}/${pageCount}, ${count} records on page.`);
        if (page < pageCount) await sleep(900 + Math.floor(Math.random() * 500));
      }

      const allCourses = core.parseCourseText(chunks.join("\n\n"));
      const courses = core.filterCourses(allCourses, departments);
      if (!courses.length) throw new Error("The department filter matched no courses. No output was saved.");
      const source = pageUrl(1);
      source.searchParams.delete("filter[cpage]");
      const capturedAt = new Date().toISOString();
      const metadata = {
        source: source.toString(),
        catalogId: source.searchParams.get("catoid"),
        navigationId: source.searchParams.get("navoid"),
        capturedAt,
        pagesExpected: pageCount,
        pagesFetched: pageCount,
        departments,
      };
      const snapshot = core.makeSnapshot(courses, metadata);
      const previousText = localStorage.getItem(STORAGE_KEY);
      const previous = previousText ? JSON.parse(previousText) : null;
      const diff = previous ? core.diffSnapshots(previous, snapshot) : null;
      const markdown = core.buildMarkdown(courses, metadata);
      const stem = `catalog-${metadata.catalogId || "current"}${departments.length ? `-${departments.join("_")}` : ""}`;

      save(`${stem}.json`, `${JSON.stringify(snapshot, null, 2)}\n`, "application/json");
      await sleep(600);
      save(`${stem}.md`, markdown, "text/markdown");
      await sleep(600);
      save(`${stem}-departments.tar`, createTar(core.buildDepartmentFiles(courses, metadata)), "application/x-tar");
      if (diff) {
        await sleep(600);
        save(`${stem}-diff.json`, `${JSON.stringify(diff, null, 2)}\n`, "application/json");
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      say(`Done: ${courses.length} courses, ${pageCount}/${pageCount} pages. ${diff ? `${diff.summary.added} added, ${diff.summary.removed} removed, ${diff.summary.changed} changed.` : "No prior browser snapshot to compare."}`);
      window.setTimeout(() => banner.remove(), 12000);
      return { snapshot, diff };
    } catch (error) {
      say(`Catalog export failed: ${error.message}`);
      throw error;
    }
  }

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Export catalog";
  button.title = "Export a complete catalog snapshot, department archive, and previous-run diff";
  button.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:10000;padding:9px 13px;border:0;border-radius:5px;background:#111;color:#fff;font:600 14px sans-serif;cursor:pointer";
  button.addEventListener("click", async () => {
    try {
      const text = prompt("Department prefixes, comma-separated. Leave empty for the full catalog.", "");
      if (text === null) return;
      button.disabled = true;
      await run({ departments: parseDepartments(text) });
    } catch (error) {
      console.error(error);
      alert(`Catalog exporter: ${error.message}`);
    } finally {
      button.disabled = false;
    }
  });
  document.body.appendChild(button);
  window.acalogCatalogExport = run;
})();
