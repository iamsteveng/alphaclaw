# STORM Research Skill — Requirements

**Source:** [@heynavtoor — "The Stanford STORM Method"](https://x.com/heynavtoor/status/2067194761446920264)
**Status:** Requirements Only (no implementation)
**Branch:** `feat/storm-research-skill`

---

## Overview

Implement a skill that runs the Stanford STORM (Synthesis of Topic Outlines through Retrieval and Multi-perspective Question Asking) research methodology inside the agent.

**Origin:** STORM was published at NAACL 2024 by the Stanford OVAL Lab. In peer-reviewed testing, STORM-produced articles were 25% more organized and 10% broader in coverage than the next best method. The system is open-source and free.

**Goal:** Compress what normally takes a PhD student 40–60 hours of multi-perspective reading into a ~5-minute agent-driven pipeline using 4 structured prompts. The agent simulates 5 expert perspectives, maps contradictions between them, synthesizes a research briefing, and then peer-reviews its own work.

---

## Skill Metadata

| Field | Value |
|-------|-------|
| **Name** | `storm-research` |
| **File** | `skills/storm-research/SKILL.md` |
| **Trigger phrases** | "research [topic]", "deep dive on [topic]", "STORM research", "storm research [topic]", "multi-perspective research", "research like a PhD" |
| **Dependencies** | Web search capability (Brave/Perplexity), optionally GBrain for prior knowledge |

---

## Core Workflow — 4 Prompt Pipeline

### Prompt 1: Five Expert Perspectives

Simulate 5 distinct expert perspectives on the given topic. Each perspective should produce:
- Core position (2 sentences)
- Strongest evidence supporting their view
- One thing only they would notice

**The 5 Perspectives:**

| # | Role | Focus | Key Question |
|---|------|-------|--------------|
| 1 | **The Practitioner** | Daily hands-on reality | What do they know that academics miss? What practical realities are usually ignored? |
| 2 | **The Academic** | Peer-reviewed evidence | What does the evidence actually say? Where does evidence contradict popular belief? |
| 3 | **The Skeptic** | Counter-narrative | What is the strongest counterargument? What evidence do proponents ignore? |
| 4 | **The Economist** | Incentives & money flows | Who profits from the current narrative? What financial incentives shape the research? |
| 5 | **The Historian** | Historical patterns | What historical parallels exist? What can we learn from how those played out? |

### Prompt 2: The Contradiction Map

Take the 5 perspectives from Prompt 1 and identify where they clash:
1. **Direct contradictions** — where two or more perspectives make incompatible claims
2. **Evidence strength ranking** — which perspective has the strongest/weakest evidence and why
3. **The resolution question** — the one question that, if answered, would resolve the biggest contradiction
4. **Universal agreement** — what EVERY perspective agrees on (high-probability truth)
5. **Blind spot** — what topic did NO perspective address (the gap in the entire field)

### Prompt 3: Research Synthesis Briefing

Synthesize everything into a CEO-ready briefing:
1. **One-Paragraph Summary** — nuanced, not just the headline; 60-second read
2. **5 Key Findings** — ranked by reliability, noting which perspectives support/challenge each
3. **Hidden Connection** — one non-obvious link visible only when all 5 perspectives are combined
4. **Actionable Insight** — what someone in the user's stated role should actually DO differently
5. **The Frontier Question** — the one question that would change everything about this topic if answered

### Prompt 4: Self Peer Review

The agent grades its own briefing:
1. **Confidence Scores** — rate each of the 5 key findings 1–10 with explanation
2. **Weakest Link** — which claim is least confident; what info would be needed to verify it
3. **Bias Check** — which perspective might be overrepresented; did one voice dominate?
4. **Missing Perspective** — is there a 6th angle that would change the conclusions?
5. **Overall Grade** — what would a Stanford professor grade this and why; what would they fix?

---

## Input Specification

```
User provides:
- topic (required): the research subject
- role (optional): user's role for the Actionable Insight in Prompt 3
- depth (optional): "quick" (single-pass) | "deep" (with web search enrichment between prompts)
- format (optional): "briefing" (default) | "report" (full markdown document) | "slides" (presentation outline)
```

---

## Output Specification

The skill outputs a structured research briefing containing all 4 prompt outputs, formatted as markdown with clear section headers. The output must include:

```markdown
# STORM Research: [Topic]
## 1. Five Perspectives
### Practitioner | Academic | Skeptic | Economist | Historian
## 2. Contradiction Map
## 3. Synthesis Briefing
## 4. Peer Review
```

---

## Implementation Requirements

### Must Have
- [ ] 4-prompt pipeline executed sequentially (each prompt's output feeds the next)
- [ ] All 5 expert perspectives simulated in Prompt 1
- [ ] Contradiction map with explicit clash identification in Prompt 2
- [ ] CEO-level synthesis with reliability ranking in Prompt 3
- [ ] Self-critique with confidence scores 1–10 in Prompt 4
- [ ] Trigger phrase matching for natural invocation
- [ ] Output formatted as structured markdown

### Should Have
- [ ] Web search enrichment: between Prompt 1 and Prompt 2, run web searches to ground each perspective with real citations/sources
- [ ] GBrain integration: check if GBrain has prior pages on the topic and incorporate existing knowledge
- [ ] Role-aware actionable insight in Prompt 3 (user can specify their role: investor, founder, engineer, etc.)
- [ ] Session persistence: save the full research briefing to GBrain as a page (e.g., `research/[topic-slug]`)

### Nice to Have
- [ ] Deep mode: run 2 iterations — first pass generates perspectives, second pass critiques and deepens
- [ ] Citation tracking: every claim in the synthesis should reference which perspective(s) it came from
- [ ] Contradiction resolution attempt: for the biggest contradiction, generate a hypothesis that reconciles both views
- [ ] Visual output option: generate a Mermaid diagram of the contradiction map
- [ ] Custom perspective support: user can add a 6th perspective (e.g., "The Regulator", "The Ethicist")

### Won't Do (v1)
- Full open-source STORM Python pipeline integration (out of scope; the 4-prompt method is the MVP)
- Reference management system (Zotero/BibTeX export)
- Multi-article generation (STORM can generate full Wikipedia-style articles; v1 is research briefing only)

---

## Quality Gates

The skill output must pass these checks before delivery:
1. **All 5 perspectives present** — no skipped roles
2. **At least 3 specific contradictions identified** in Prompt 2
3. **All 5 key findings have reliability scores 1–10** in Prompt 4
4. **At least one blind spot or missing perspective identified**
5. **Actionable insight is role-specific** (not generic advice)

---

## Design Decisions (to be finalized during implementation)

| Decision | Options | Recommendation |
|----------|---------|----------------|
| Single agent run vs sub-agent per perspective | 1 agent doing all 4 prompts vs. spawning 5 sub-agents for Prompt 1, then merging | Single agent for v1 (simpler, fewer context management issues); sub-agents for v2 (parallelism) |
| Web search: before or during Prompt 1? | Pre-search to ground all perspectives vs. search-as-you-go | Pre-search the topic, then let each perspective reference results; do NOT inject search results mid-perspective (breaks the simulation) |
| Output destination | Telegram reply only vs. save to GBrain + reply | Reply with summary + save full briefing to GBrain (`research/[slug]`) |
| Model selection | Default model vs. high-thinking model | Use high-thinking mode (reasoning on) for all 4 prompts — this is research-grade work |

---

## References

- STORM Paper: NAACL 2024, Stanford OVAL Lab
- Live Tool: https://storm.genie.stanford.edu
- Open Source: https://github.com/stanford-oval/storm (MIT License)
- Original Thread: https://x.com/heynavtoor/status/2067194761446920264
- Condensed Gist: https://gist.github.com/thevillagehacker/e09c947b2281827692d43c8ace835049
