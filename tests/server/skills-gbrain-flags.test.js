const fs = require("fs");
const path = require("path");

// Guard against the class of bug fixed in PR #66: skills invoked
// `gbrain list --filter type=<type>`, but `gbrain list` has no `--filter`
// option. gbrain SILENTLY IGNORES unknown flags, so the command returned every
// page instead of filtering — wrong data, no error. This test fails loudly if
// any skill's `gbrain list` invocation uses a flag outside gbrain's real set,
// catching `--filter` and any future typo before it ships.
//
// Valid flags are from `gbrain list --help` (verified live on prod-peter):
//   --type --tag --limit --updated-after --sort --include-deleted
// (--help is always allowed.)

const SKILLS_DIR = path.join(__dirname, "../../lib/setup/skills");

const VALID_LIST_FLAGS = new Set([
  "--type",
  "--tag",
  "--limit",
  "--updated-after",
  "--sort",
  "--include-deleted",
  "--help",
]);

const findSkillFiles = (dir) => {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findSkillFiles(full));
    else if (entry.name === "SKILL.md") out.push(full);
  }
  return out;
};

// Extract long flags from a `gbrain list …` invocation, stopping at the first
// shell separator so flags belonging to a piped/chained command aren't counted.
const listFlagsOnLine = (line) => {
  const idx = line.indexOf("gbrain list");
  if (idx === -1) return [];
  let segment = line.slice(idx + "gbrain list".length);
  segment = segment.split(/[|;&]|&&/)[0];
  return segment.match(/--[a-z][a-z-]*/g) || [];
};

describe("skills: gbrain list flags", () => {
  const files = findSkillFiles(SKILLS_DIR);

  it("finds skill files to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("every `gbrain list` invocation uses only real gbrain flags", () => {
    const violations = [];
    for (const file of files) {
      const rel = path.relative(SKILLS_DIR, file);
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const flag of listFlagsOnLine(line)) {
          if (!VALID_LIST_FLAGS.has(flag)) {
            violations.push(`${rel}:${i + 1}  invalid \`gbrain list\` flag ${flag} — did you mean --type? (gbrain silently ignores unknown flags)`);
          }
        }
      });
    }
    expect(violations, `\n${violations.join("\n")}\n`).toEqual([]);
  });
});
