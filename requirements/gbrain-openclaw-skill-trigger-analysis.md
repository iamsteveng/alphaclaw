# GBrain + OpenClaw: Skill Structure & Trigger Resolution — Full Analysis

## Overview

When gbrain is installed in an OpenClaw workspace, skill triggering works through a
**two-layer system**: OpenClaw's runtime injects skill metadata into the agent's system
prompt, and the LLM resolves which skill to invoke based on a combination of that
injected context plus gbrain's own agent-instruction file. This document traces the
entire chain from installation to execution.

---

## 1. The Installation Bridge — `openclaw.plugin.json`

gbrain declares itself to OpenClaw as a `bundle-plugin` via `openclaw.plugin.json`:

```json
{
  "name": "gbrain",
  "family": "bundle-plugin",
  "mcpServers": {
    "gbrain": { "command": "./bin/gbrain", "args": ["serve"] }
  },
  "skills": [
    "skills/capture",
    "skills/query",
    "skills/signal-detector",
    "skills/brain-ops",
    "... (43 total)"
  ],
  "shared_deps": [
    "skills/conventions",
    "skills/_AGENT_README.md",
    "skills/_brain-filing-rules.md",
    "skills/_output-rules.md"
  ],
  "resolver": "RESOLVER.md"
}
```

Two things get wired here:

- **MCP server** — `./bin/gbrain serve` is registered as an MCP server. It exposes
  the brain tools the LLM calls when executing skill workflows (`get_page`, `put_page`,
  `add_link`, `add_timeline_entry`, etc.).
- **Skills list** — the 43 skill directories the plugin contributes to the workspace.

### Scaffolding into the workspace

`gbrain skillpack scaffold --all` copies each skill directory from gbrain's bundle into
`<workspaceDir>/skills/<slug>/`. On every AlphaClaw startup, `syncWorkspaceSkills`
(called from `syncBootstrapPromptFiles`) re-syncs `lib/setup/skills/` → `workspace/skills/`,
ensuring skills are always present.

The shared dependencies (`_AGENT_README.md`, `_brain-filing-rules.md`, `_output-rules.md`,
`RESOLVER.md`, `conventions/`) are also copied — they are cross-cutting operating contracts
the agent reads independently of any specific skill invocation.

---

## 2. Skill Discovery — OpenClaw's Runtime Scanner

On session start, OpenClaw calls `loadWorkspaceSkillEntries` → `loadSkillsFromDirSafe`,
which walks `<workspaceDir>/skills/`:

```
workspace/skills/
  capture/SKILL.md
  query/SKILL.md
  signal-detector/SKILL.md
  brain-ops/SKILL.md
  ...
```

For each subdirectory it finds, `loadSingleSkillDirectory` runs:

1. Reads `SKILL.md` via `readSkillFileSync` (symlink-rejected, size-capped)
2. Calls `parseFrontmatter(raw)` to extract YAML header
3. Extracts `name` (falls back to directory name) and `description`
4. Checks `disable-model-invocation` flag (some skills are invoked differently)
5. Returns a typed skill object:

```ts
{
  name: "capture",
  description: "Save any thought or content...",
  filePath: "/workspace/skills/capture/SKILL.md",
  baseDir: "/workspace/skills/capture",
  source: "workspace",
  disableModelInvocation: false
}
```

**Only `name` and `description` are extracted for prompt injection** — not `triggers:`,
not `tools:`, not `mutating:`. The full frontmatter is retained internally (in
`frontmatterByFilePath`) for policy decisions (e.g., `shouldIncludeSkill`,
`resolveSkillInvocationPolicy`) but not sent to the model.

---

## 3. Prompt Injection — The `<available_skills>` Block

`buildWorkspaceSkillsPrompt` calls `formatSkillsForPrompt`, which constructs this XML
and appends it to the agent's system prompt for every new session:

```xml
The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory
(parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
  <skill>
    <name>capture</name>
    <description>Save any thought or content into the brain via one CLI command. The single human-facing entrypoint that replaces "put_page vs commit-then-sync vs autopilot-wait" with one command that just works.</description>
    <location>/workspace/skills/capture/SKILL.md</location>
  </skill>
  <skill>
    <name>signal-detector</name>
    <description>Always-on ambient signal capture. Fires on every message to detect original thinking and entity mentions.</description>
    <location>/workspace/skills/signal-detector/SKILL.md</location>
  </skill>
  <!-- ... all 43 skills ... -->
</available_skills>
```

This is the **primary dispatch surface**: the LLM sees every skill's name and description
and uses that to decide which skill file to read.

---

## 4. The Two-Layer Trigger System

Trigger resolution in the gbrain+OpenClaw stack is dual-layered. The two layers are
complementary: OpenClaw handles the structural injection, gbrain handles the
agent-instruction matching protocol.

### Layer 1 — OpenClaw Runtime: Description-Based Matching

The injected instruction is:

> **"Use the `read` tool to load a skill's file when the task matches its description."**

The LLM performs fuzzy semantic matching against the `<description>` text in
`<available_skills>`. When the user says "capture this thought", the LLM matches
against:

```
description: Save any thought or content into the brain via one CLI command...
```

This is **implicit trigger matching** — no explicit trigger phrase list is shown;
the model reasons over natural language descriptions.

### Layer 2 — gbrain Agent-Instruction: Frontmatter Trigger Matching

`skills/_AGENT_README.md` is scaffolded as a shared dependency and loaded alongside
skills. It instructs the agent:

> "Discover skills at runtime by walking every `skills/<slug>/SKILL.md` here and
> parsing the YAML frontmatter. Each skill declares one or more `triggers:` strings;
> they are the user-facing phrases that route to that skill."
>
> "On every user message, match the message against every skill's `triggers:` array.
> Substring match is the baseline. Semantic similarity (embedding or keyword expansion)
> is fine on top."

Each skill's YAML frontmatter declares its explicit triggers:

```yaml
---
name: capture
triggers:
  - "capture this"
  - "save this thought"
  - "remember this"
  - "drop this in the inbox"
  - "save to brain"
---
```

This is **explicit trigger matching** — the agent is told to pattern-match the user
message against the `triggers:` array strings, using substring match as the floor
and semantic similarity as an optional ceiling.

`_AGENT_README.md` also explicitly notes:

> **"Do NOT look for a managed-block table inside `RESOLVER.md` or `AGENTS.md`. That
> pattern was retired in gbrain v0.36. Routing lives in frontmatter now."**

`RESOLVER.md` remains as a **human-readable reference table** for maintainers — it maps
triggers to skills in a markdown table — but the agent's authoritative routing source is
the frontmatter in each `SKILL.md`.

### How the Two Layers Work Together

```
User message: "save this to brain"
        │
        ▼
Layer 1 (OpenClaw):
  LLM scans <available_skills> descriptions
  → "capture" description mentions "save" → candidate match
  → "ingest" description mentions "save to brain" → also candidate
        │
        ▼
Layer 2 (gbrain _AGENT_README.md):
  LLM is instructed to also check triggers[] in frontmatter
  → capture/SKILL.md triggers: ["save this thought", "save to brain"] → substring hit
  → ingest/SKILL.md triggers: ["save this to brain"] → substring hit
        │
        ▼
Disambiguation (RESOLVER.md rules):
  → "save to brain" is more specific to capture than generic ingest
  → Prefer most specific skill → invoke capture
```

---

## 5. Disambiguation Rules

When multiple skills match, `RESOLVER.md` defines the tiebreak order:

| Priority | Rule |
|---|---|
| 1 | **Specificity wins** — `meeting-ingestion` beats `ingest` |
| 2 | **URL present** → route by content type (link → `idea-ingest`, video → `media-ingest`) |
| 3 | **Person/company name** → check if `enrich` or `query` fits better |
| 4 | **Chaining is explicit** — each skill's Phases section names what to chain into |
| 5 | **When in doubt** → invoke `skills/ask-user/SKILL.md` (choice-gate pattern) |

---

## 6. Always-On Skills — Pre-Dispatch Parallel Execution

Two skills bypass trigger matching entirely. They fire **on every inbound message**,
spawned in parallel and non-blocking:

| Skill | Trigger | Purpose |
|---|---|---|
| `signal-detector` | Every message | Ambient entity/signal capture — detects original thinking and entity mentions |
| `brain-ops` | Any brain read/write/lookup/citation | The core read/write cycle; brain-first lookup before any external API call |

These are declared always-on in `RESOLVER.md` under "Always-on (every message)" and
confirmed by `signal-detector`'s description: *"Fires on every message."*

---

## 7. Skill Execution — Full Read-Then-Follow Cycle

Once a skill is identified:

1. **LLM uses the `read` tool** to load the full `SKILL.md` from `<location>`
2. Reads the **`## Contract`** section (guarantees)
3. Executes the **`## Phases`** section step by step
4. Calls gbrain MCP tools as needed (`get_page`, `put_page`, `add_link`, etc.)
5. Follows any chaining instructions ("for meeting data, chain into `meeting-ingestion`")
6. Consults shared conventions (`_brain-filing-rules.md`, `conventions/quality.md`) on
   every brain write

If a skill has a `script.ts` paired source file, the LLM does not run it directly unless
`SKILL.md` explicitly instructs it to — the script is reference code for the gbrain CLI.

---

## 8. The MCP Tool Layer — gbrain's Write Surface

The gbrain MCP server (`gbrain serve`) is the execution layer. Skills are *instructions*;
MCP tools are *actions*. The full tool set available to the agent:

| MCP Tool | Purpose |
|---|---|
| `get_page` | Read a page from the brain DB |
| `put_page` | Write/update a brain page |
| `add_timeline_entry` | Append to entity timeline |
| `add_link` | Create typed link between entities |
| `get_backlinks` | Retrieve back-links for a page |
| `add_tag` / `get_tags` | Tag management |
| `put_raw_data` | Store raw API responses |
| `search` | Hybrid RAG search across the brain |
| `sync_brain` | Trigger brain sync |

Skills declare which tools they use in their `tools:` frontmatter field — this is
documentation, not enforcement. The MCP server enforces trust boundaries independently:
`remote: true` calls (from MCP/agent) get tighter filesystem confinement than
`remote: false` calls (from CLI).

---

## 9. Complete End-to-End Flow

```
┌─────────────────────────────────────────────────────────────┐
│  INSTALL TIME                                               │
│                                                             │
│  gbrain skillpack scaffold --all                           │
│    → copies skills/*/ into workspace/skills/               │
│    → copies _AGENT_README.md, RESOLVER.md, conventions/    │
│                                                             │
│  AlphaClaw syncWorkspaceSkills (every startup)             │
│    → lib/setup/skills/ → workspace/skills/                 │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  SESSION START                                              │
│                                                             │
│  OpenClaw: loadWorkspaceSkillEntries                       │
│    → walk workspace/skills/*/SKILL.md                      │
│    → parseFrontmatter → extract name + description          │
│    → filter via shouldIncludeSkill                         │
│                                                             │
│  formatSkillsForPrompt                                     │
│    → build <available_skills> XML block                    │
│    → inject into agent system prompt                       │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  USER MESSAGE ARRIVES                                       │
│                                                             │
│  Always-on (parallel, non-blocking):                       │
│    → signal-detector fires                                 │
│    → brain-ops fires (if brain op detected)                │
│                                                             │
│  Layer 1 — Description match (OpenClaw):                   │
│    LLM reasons over <available_skills> descriptions        │
│    → candidate skill(s) identified                         │
│                                                             │
│  Layer 2 — Trigger match (_AGENT_README.md):               │
│    LLM checks SKILL.md triggers[] frontmatter              │
│    → substring / semantic match                            │
│                                                             │
│  Disambiguation (RESOLVER.md rules):                       │
│    → specificity → content type → entity type → ask-user  │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  SKILL EXECUTION                                            │
│                                                             │
│  LLM: read(skill.filePath)     ← uses OpenClaw read tool   │
│  LLM: follow ## Phases                                     │
│  LLM: call MCP tools as needed                             │
│    → gbrain serve (get_page, put_page, add_link, ...)      │
│  LLM: consult _brain-filing-rules.md on writes             │
│  LLM: chain to next skill if Phases says so                │
└─────────────────────────────────────────────────────────────┘
```

---

## 10. Key Architectural Decisions

### Why frontmatter triggers, not RESOLVER.md?

`RESOLVER.md` was the original routing table (pre-v0.36), maintained as a
managed-block markdown file. It required manual synchronization between the file and
each skill's actual trigger intent. With frontmatter triggers (v0.36+), each skill owns
its routing contract. RESOLVER.md is auto-generated documentation; frontmatter is the
source of truth. MECE validation at skill creation time enforces no overlap.

### Why description-based (Layer 1) AND explicit triggers (Layer 2)?

Layer 1 (description) is coarse but requires no extra LLM instruction — the model
already knows to scan `<available_skills>`. Layer 2 (frontmatter triggers) is precise
— it gives the model exact strings to substring-match against, reducing ambiguous
matches. Together they handle both typed commands ("capture this") and natural language
intent ("I want to remember this article").

### Why always-on skills bypass trigger matching?

Signal detection and brain-first lookup are invariants, not options. Routing them
through trigger matching would mean they'd only fire when the user explicitly triggers
them — which defeats their purpose as ambient background processes that compound the
brain's knowledge over time.

### The `disable-model-invocation` escape hatch

Skills that are purely programmatic (e.g., `publish`, which generates static HTML via
CLI with zero LLM calls) set `disable-model-invocation: true` in frontmatter.
OpenClaw's `resolveSkillInvocationPolicy` picks this up and routes them differently —
they're triggered by a slash command or direct CLI call rather than LLM description
matching.
