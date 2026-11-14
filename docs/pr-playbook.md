# PR playbook

How a change becomes a merged PR in this repository. It is written from what
PR #29 actually did, plus the review checklist shape of
`NousResearch/hermes-agent`, trimmed to what this repo uses.

The template is `.github/PULL_REQUEST_TEMPLATE.md`, so opening a PR already
gives you the skeleton. This page explains how to fill it and what happens after.

## 1. Branch

`type/scope-kebab-case`, matching the commit type:

- `feat/auto-pair-no-token-copy`
- `fix/ai-web-routing-complexity`
- `docs/pr-playbook`
- `ci/cache-pip-apt`

One branch, one concern. If a review uncovers an unrelated bug, fix it in a
separate branch and PR; do not bundle it (see the checklist's "no drive-by
edits").

## 2. Commits

Conventional Commits, lowercase scope, imperative subject:

```
feat(auth): pair the extension without copying a token
fix(extension): stop redialling the bridge with a missing token
fix: log where the A2A token file was created (Kilo)
ci: cache pip and apt packages with actions/cache
```

The body answers **why**, not what the diff already shows. PR #29's message is
the model: it names the upstream behaviour, the cost of the fork's hardening, and
the three bullet points that resolve it. Lines wrap at ~80 columns.

A commit that answers a review finding carries the finding in the subject suffix
`(Kilo)` and quotes the problem in the body, so the thread and the history agree.

## 3. PR body

Title = the main commit subject. Body order:

1. **What changed** - the problem, why this approach, what to hold in mind.
2. **Before / after** - a table when behaviour changed. PR #29 compared upstream,
   this fork before, this fork after, on the axes that matter to a user rather
   than to the diff (auth, connect flow, what can reach the bridge).
3. **Verification** - a table of commands with real results. Include the awkward
   cases: what was rejected before and accepted now, quoted startup lines, grep
   proofs that stale instructions are gone. "All tests pass" is not verification;
   `pytest -q 122 passed` is.
4. **Trade-off** - what the change gives up, plainly. If the answer is "nothing",
   say why the obvious cost does not apply.
5. **Risk and rollback** - how to undo it. For this repo that is usually "revert
   the squash commit; no migration, no persisted state".

Keep it in plain ASCII (`->`, not arrows), matching the code and docs.

## 4. Labels

Automatic, from `.github/labeler.yml` and `.github/workflows/labeler.yml`:

- area: `bridge`, `extension`, `documentation`, `security`, `ci`, `tests`
- size: `size/xs` (<20 changed lines) through `size/xl` (>=1000), recomputed on
  every push

Manual only when the path rules miss the meaning: `bug`, `enhancement`,
`question`. Fork PRs are skipped by the labeler because their token is
read-only - apply labels by hand there.

## 5. CI

Two required jobs in `.github/workflows/tests.yml`:

- `tests`: pyflakes, `pytest -q`, `node --check` on the extension and
  `core/*.js`, then the eight stub-DOM suites.
- `e2e`: real bridge in a subprocess on an ephemeral port, with bubblewrap.

Run the same commands locally before pushing:

```bash
python -m pyflakes workspace_mcp.py bridge.py bridge_auth.py setup-config.py tests/*.py e2e/*.py
python -m pytest -q
for f in snapgent-extension/test-*.js; do node "$f"; done
```

A red check is never fixed by skipping it, loosening an assertion, or adding a
`noqa`. Fix the cause; if the cause is the requested behaviour, say so in the PR
and verify the new behaviour explicitly.

## 6. Review bot (Kilo)

Every PR gets an automated review. The loop:

1. Read the finding, open the cited line, decide whether it is real.
2. If real: fix it in its own commit, subject ending `(Kilo)`, body quoting the
   finding and what the fix does.
3. If not real: reply in the thread with the reason, with a line number or test
   as evidence. Do not resolve silently.
4. Push. The bot re-reviews the new commit and posts a replacement summary; the
   newest summary is authoritative.

PR #29 shows the whole cycle: one `SUGGESTION` (unused `token_created`), a `fix:`
commit that used the value to log the token path, then "No Issues Found |
Recommendation: Merge".

## 7. Approval and merge

- All checks green, bot at "No Issues Found", trade-off documented.
- Squash merge into `main`; the PR title becomes the commit subject.
- Delete the branch after merge.
- If the PR changed user-facing behaviour or setup, the docs change is part of
  the same PR, not a follow-up.

## 8. What #29 did that is worth copying

- Opened with a comparison table instead of a description of the diff.
- Quoted the exact new startup line the user will see.
- Proved documentation was consistent (`grep -ri "paste the token" ...` returns
  nothing) instead of claiming it.
- Named the security trade-off in one paragraph, with the escape hatch
  (`ZS_BRIDGE_AUTH=strict`) and who it protects against.
- Kept the review fix as a separate, self-explanatory commit.
