<!--MAC-BLOCK:BEGIN-->

## 🚨 Multi-Agent Coordination

This project runs **3** Claude Code terminals in parallel. Coordination is enforced by three artifacts at the repo root: `active_tasks.md` (kanban), `active_files.md` (file locks), and `.multi-agent/config.json` (settings). The kanban + lock files are gitignored (live state); the config is committed so team members get the same settings on clone.

### Terminal roles

| Label | Role      | May write code? | Responsibilities                                                  |
| ----- | --------- | --------------- | ---------------------------------------------------------------- |
| `T1`  | Developer | Yes             | Implements tasks assigned to T1; locks files; verifies; commits after approval. |
| `T2`  | Developer | Yes             | Implements tasks assigned to T2; locks files; verifies; commits after approval. |
| `P`   | Planner   | No              | Plans, dispatches tasks, reviews diffs, approves/blocks. Never edits source directly. |

If unsure which terminal you are at session start, run `/agent-intro` or ask the user.

### File-lock protocol (mandatory before every edit)

Before editing **any** file:

1. Read `active_files.md`.
2. If the target path is listed by another terminal and the timestamp is fresher than **15 minutes**, wait 30s and re-check. Loop until the lock disappears.
3. If listed by another terminal but older than TTL: it's stale — per project policy (warn user before clearing).
4. If not listed: append `- <path> → T<N> @ <ISO-timestamp>` (developers) or `- <path> → P @ <ISO-timestamp>` (planner) and proceed.
5. Edit.
6. Remove your line from `active_files.md` immediately when done.

Read-only operations (`Read`, `Grep`, `git status`, `git diff`) do NOT need a lock.

### Shared kanban (`active_tasks.md`)

Four sections in order: 🟢 IN PROGRESS / TODO → 🟡 AWAITING REVIEW → 🟠 BLOCKED → ✅ DONE.

- **Planner** writes new tasks into TODO with full file lists, acceptance criteria, and an assignee (T1 / T2 / …).
- **Developer** picks up the task, locks files, implements, runs verification, moves the task to AWAITING REVIEW with a status note.
- **STOP** at AWAITING REVIEW. Do NOT commit until the user relays planner approval.
- After approval: pull-rebase → `git add` specific files → commit → push → move to DONE with commit hash.

### Approval gate

**Enabled.** Developers must NOT run `git add` / `git commit` / `git push` until the Planner has reviewed the uncommitted diff and the user has relayed an explicit "approved" message. Developers signal readiness by moving the task to 🟡 AWAITING REVIEW in `active_tasks.md` and saying so in chat. The Planner verifies via `git diff` + build + test + manual exercise, then approves or blocks. Exceptions: pure-docs / planning-file edits and explicit user-authorized hotfixes.

### Git workflow — Variant B (single integration branch)

Two-branch model. Developers commit directly to the integration branch **`dev`** after approval — no per-task feature branches (the Planner approval gate plays the code-review role). Before committing: `git fetch && git pull --rebase origin dev`, then stage specific files (never `git add -A`) and push to `dev`. Releases promote `dev → main` via a release PR, then tag on **`main`**.

### Project verification commands

- **Typecheck / build:** `npm run build`
- **Tests:** `npm test`

Run both before moving any task to AWAITING REVIEW.

### Commit format

**Conventional Commits** — `<type>(<scope>): <description>`. Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `style`, `perf`, `build`, `ci`. Keep the description imperative and lowercase (e.g. `feat(popup): add dark mode toggle`).

### Reference

Full coordination protocol: load the `multi-agent-coordination` skill or read its references directly (`lock-protocol.md`, `approval-gate.md`, `git-workflow-variants.md`, `troubleshooting.md`).
<!--MAC-BLOCK:END-->
