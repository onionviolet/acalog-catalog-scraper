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
