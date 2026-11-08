---
tags: [resource, memory]
date: 2026-11-07
status: active
---

# Memory: dev-server-hygiene

_Copied from Claude auto-memory._

On the owner's Mac another project (Athena) keeps a Next dev server on :3000. During phase 1b (2026-10-29) a subagent ran a broad `pkill -n next-server` and took it down (its autostart brought it back). Docker Desktop also stopped twice mid-run.

**Why:** the ERP-IA dev server (:3100, `.claude/launch.json`) is not the only next-server process on the machine.

**How to apply:** every implementer brief says: stop/start only the :3100 server through the preview tools (or `lsof -ti:3100`), never `pkill next-server`; check Docker is up before `db:reset`. Related: [[Memory - enforce-rules-and-design]].

Index: [[Memory Notes]].
