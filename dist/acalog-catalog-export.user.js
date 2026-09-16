// ==UserScript==
// @name         Modern Campus Catalog Export
// @namespace    https://github.com/onionviolet/acalog-catalog-scraper
// @version      3.0.0
// @description  Export complete Modern Campus catalogs to Markdown, JSON, per-department files, and diffs.
// @match        https://catalog.wlu.edu/content.php*
// @grant        none
// ==/UserScript==

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AcalogCatalogCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const COURSE_HEADER = /^([A-Z]{2,5})\s+(\d{3,4}[A-Z]?)\s*[-\u2013]\s*(.+)$/;

  function clean(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function markerPositions(blob) {
    const markers = [];
    const expressions = [
      ["prerequisites", /\bPrerequisites?:\s*/gi],
      ["corequisites", /\bCorequisites?:\s*/gi],
      ["fdr", /\bFDR:\s*/gi],
      ["credits", /\bCredits?:\s*/gi],
    ];
    for (const [name, expression] of expressions) {
      const match = expression.exec(blob);
      if (match) markers.push({ name, start: match.index, valueStart: match.index + match[0].length });
    }
    return markers.sort((a, b) => a.start - b.start);
  }

  function splitFields(blob) {
    const text = clean(blob);
    const markers = markerPositions(text);
    if (!markers.length) {
      return { title: text, prerequisites: "", corequisites: "", fdr: "", credits: "", description: "" };
    }

    const fields = {
      title: clean(text.slice(0, markers[0].start)),
      prerequisites: "",
      corequisites: "",
      fdr: "",
      credits: "",
      description: "",
    };
    for (let index = 0; index < markers.length; index += 1) {
      const marker = markers[index];
      const end = index + 1 < markers.length ? markers[index + 1].start : text.length;
      fields[marker.name] = clean(text.slice(marker.valueStart, end));
    }

    if (fields.credits) {
      const match = fields.credits.match(/^(\d+(?:\.\d+)?(?:\s*[-\u2013]\s*\d+(?:\.\d+)?)?)\s*(.*)$/);
      if (match) {
        fields.credits = clean(match[1]).replace(/\u2013/g, "-");
        fields.description = clean(match[2]);
      }
    }
    return fields;
  }

  function parseCourseText(raw) {
    const records = [];
    let current = null;
    for (const rawLine of String(raw || "").replace(/\r/g, "").split("\n")) {
      const line = clean(rawLine);
      if (!line) continue;
      const match = line.match(COURSE_HEADER);
      if (match) {
        if (current) records.push(current);
        current = {
          code: `${match[1]} ${match[2]}`,
          prefix: match[1],
          number: match[2],
          blob: match[3],
        };
      } else if (current) {
        current.blob = `${current.blob} ${line}`;
      }
    }
    if (current) records.push(current);

    const unique = new Map();
    for (const record of records) {
      if (unique.has(record.code)) continue;
      const fields = splitFields(record.blob);
      unique.set(record.code, {
        code: record.code,
        prefix: record.prefix,
        number: record.number,
        ...fields,
      });
    }
    return [...unique.values()].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  }

  function filterCourses(courses, departments) {
    const wanted = new Set((departments || []).map((value) => clean(value).toUpperCase()).filter(Boolean));
    if (!wanted.size) return [...courses];
    return courses.filter((course) => wanted.has(course.prefix));
  }

  function groupCourses(courses) {
    const groups = {};
    for (const course of courses) (groups[course.prefix] ||= []).push(course);
    return Object.fromEntries(Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)));
  }

  function fnv1a(value) {
    let hash = 0x811c9dc5;
    const bytes = new TextEncoder().encode(String(value));
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }

  function stableCourse(course) {
    return {
      code: course.code,
      prefix: course.prefix,
      number: course.number,
      title: course.title,
      prerequisites: course.prerequisites,
      corequisites: course.corequisites,
      fdr: course.fdr,
      credits: course.credits,
      description: course.description,
    };
  }

  function fingerprint(course) {
    return fnv1a(JSON.stringify(stableCourse(course)));
  }

  function makeSnapshot(courses, metadata) {
    const stable = courses.map((course) => ({ ...stableCourse(course), fingerprint: fingerprint(course) }));
    return {
      schema_version: 1,
      source: metadata.source,
      catalog_id: metadata.catalogId || null,
      navigation_id: metadata.navigationId || null,
      captured_at: metadata.capturedAt,
      pages_expected: metadata.pagesExpected,
      pages_fetched: metadata.pagesFetched,
      department_filter: metadata.departments || [],
      course_count: stable.length,
      department_count: new Set(stable.map((course) => course.prefix)).size,
      courses: stable,
    };
  }

  function diffSnapshots(previous, current) {
    const before = new Map((previous?.courses || []).map((course) => [course.code, course]));
    const after = new Map((current?.courses || []).map((course) => [course.code, course]));
    const added = [...after.keys()].filter((code) => !before.has(code)).sort();
    const removed = [...before.keys()].filter((code) => !after.has(code)).sort();
    const changed = [...after.keys()].filter((code) => before.has(code)
      && (before.get(code).fingerprint || fingerprint(before.get(code)))
        !== (after.get(code).fingerprint || fingerprint(after.get(code))))
      .sort().map((code) => {
        const oldCourse = before.get(code);
        const newCourse = after.get(code);
        const fields = Object.keys(stableCourse(newCourse)).filter((field) => oldCourse[field] !== newCourse[field]);
        return { code, fields, before: fingerprint(oldCourse), after: fingerprint(newCourse) };
      });
    return {
      schema_version: 1,
      previous_catalog_id: previous?.catalog_id || null,
      current_catalog_id: current?.catalog_id || null,
      previous_captured_at: previous?.captured_at || null,
      current_captured_at: current?.captured_at || null,
      added,
      removed,
      changed,
      summary: { added: added.length, removed: removed.length, changed: changed.length },
    };
  }

  function courseMarkdown(course) {
    const lines = [`**${course.code} - ${course.title}**`];
    if (course.prerequisites) lines.push(`Prerequisites: ${course.prerequisites}`);
    if (course.corequisites) lines.push(`Corequisites: ${course.corequisites}`);
    if (course.fdr) lines.push(`FDR: ${course.fdr}`);
    if (course.credits) lines.push(`Credits: ${course.credits}`);
    if (course.description) lines.push("", course.description);
    return `${lines.join("\n")}\n`;
  }

  function buildMarkdown(courses, metadata, heading) {
    const groups = groupCourses(courses);
    const lines = buildIndexLines(courses, metadata, heading);
    for (const [prefix, rows] of Object.entries(groups)) {
      lines.push("", `## ${prefix}`, "");
      for (const course of rows) lines.push(courseMarkdown(course));
    }
    return `${lines.join("\n").trim()}\n`;
  }

  function buildIndexLines(courses, metadata, heading) {
    const groups = groupCourses(courses);
    const lines = [
      `# ${heading || "Course Catalog Export"}`,
      "",
      `Source: ${metadata.source}`,
      `Captured: ${metadata.capturedAt}`,
      `Completeness: ${metadata.pagesFetched}/${metadata.pagesExpected} pages`,
      `Courses: ${courses.length} across ${Object.keys(groups).length} departments`,
      "",
      "## Index",
      "",
    ];
    for (const [prefix, rows] of Object.entries(groups)) {
      const chars = rows.reduce((total, course) => total + courseMarkdown(course).length, 0);
      lines.push(`- **${prefix}**: ${rows.length} courses, about ${Math.ceil(chars / 4).toLocaleString()} tokens`);
    }
    return lines;
  }

  function buildDepartmentFiles(courses, metadata) {
    const files = {
      "_INDEX.md": `${buildIndexLines(courses, metadata, "Course Catalog Department Index").join("\n").trim()}\n`,
    };
    for (const [prefix, rows] of Object.entries(groupCourses(courses))) {
      files[`${prefix}.md`] = buildMarkdown(rows, metadata, `${prefix} Courses`);
    }
    return files;
  }

  return {
    COURSE_HEADER,
    buildDepartmentFiles,
    buildMarkdown,
    diffSnapshots,
    filterCourses,
    fingerprint,
    groupCourses,
    makeSnapshot,
    parseCourseText,
    splitFields,
  };
});

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
