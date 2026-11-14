## What changed

<!-- One paragraph: the problem, why this approach, and what a reader should
     hold in their head while reviewing. Link the issue if one exists. -->

Fixes #

## Before / after

<!-- A small table beats prose when behaviour changed. Delete if not useful. -->

| | before | after |
|---|---|---|
| | | |

## Verification

<!-- Facts, not adjectives. Paste the command and its result. A live check that
     compares old and new policy is worth more than a passing suite alone. -->

| check | result |
|---|---|
| `python -m pytest -q` | |
| `python -m pyflakes ...` | |
| `node snapgent-extension/test-*.js` | |
| live check | |

## Trade-off

<!-- What this gives up, stated plainly. If nothing, say "none" and why. -->

## Checklist

- [ ] Commits follow Conventional Commits (`fix(scope):`, `feat(scope):`)
- [ ] PR title is the same conventional form as the main commit
- [ ] Only changes related to this fix/feature; no drive-by edits
- [ ] Tests added or updated for the changed behaviour
- [ ] CI is green (`tests`, `e2e`, plus `labeler` on PRs from this repo)
- [ ] Docs updated where behaviour or setup changed — or N/A
- [ ] Review bot findings answered in-thread and fixed in their own commit
