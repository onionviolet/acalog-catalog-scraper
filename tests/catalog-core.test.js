const assert = require("assert");
const core = require("../src/catalog-core.js");

const sample = `
CSCI 1100 - Introduction to Computer Science Prerequisite: MATH 1010 FDR: SC Credits: 4 Learn computational problem solving.
CSCI 2100 - Software Development Prerequisites: CSCI 1200 Corequisite: CSCI 2099 Credits: 3-4 Build maintainable software.
MATH 1400 - Introduction to Mathematical Reasoning Credits: 3 Statements, proofs, and counting.
CSCI 1100 - duplicate boundary record
`;

const courses = core.parseCourseText(sample);
assert.strictEqual(courses.length, 3);
assert.deepStrictEqual(courses.map((course) => course.code), ["CSCI 1100", "CSCI 2100", "MATH 1400"]);
assert.strictEqual(courses[0].prerequisites, "MATH 1010");
assert.strictEqual(courses[0].fdr, "SC");
assert.strictEqual(courses[0].credits, "4");
assert.strictEqual(courses[0].description, "Learn computational problem solving.");
assert.strictEqual(courses[1].corequisites, "CSCI 2099");
assert.strictEqual(courses[1].credits, "3-4");

const filtered = core.filterCourses(courses, ["MATH"]);
assert.deepStrictEqual(filtered.map((course) => course.code), ["MATH 1400"]);

const metadata = {
  source: "https://catalog.example/content.php?catoid=1",
  catalogId: "1",
  navigationId: "2",
  capturedAt: "2026-09-16T00:00:00Z",
  pagesExpected: 2,
  pagesFetched: 2,
  departments: [],
};
const first = core.makeSnapshot(courses, metadata);
const changedCourses = courses.map((course) => ({ ...course }));
changedCourses[0].description = "Changed description.";
changedCourses.pop();
changedCourses.push(core.parseCourseText("POL 1005 - Introduction to Global Politics Credits: 3 Politics.")[0]);
const second = core.makeSnapshot(changedCourses, { ...metadata, catalogId: "2" });
const diff = core.diffSnapshots(first, second);
assert.deepStrictEqual(diff.summary, { added: 1, removed: 1, changed: 1 });
assert.deepStrictEqual(diff.changed[0].fields, ["description"]);

const files = core.buildDepartmentFiles(courses, metadata);
assert.ok(files["_INDEX.md"].includes("Completeness: 2/2 pages"));
assert.ok(!files["_INDEX.md"].includes("**CSCI 1100 -"));
assert.ok(files["CSCI.md"].includes("CSCI 1100"));
assert.ok(files["MATH.md"].includes("MATH 1400"));

console.log("catalog core tests passed");
