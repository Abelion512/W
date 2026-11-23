# Audit follow-up — 2026-11-22

Companion to `docs/audit-2026-11-20.md`. Status of the 25-item follow-up list,
with the evidence produced in this session. "Code done" means tests and static
checks pass; it does not claim a live browser or an external service was used.

## Verification run (repo root)

```text
python3 -m pytest -q                       -> 180 passed in 23.24s
python3 e2e/e2e_live.py                    -> 26/26 PASS
python3 -m pyflakes *.py tests/*.py e2e/*.py scripts/*.py -> clean
node --check  (extension + app JS)         -> NODE SYNTAX OK
node snapgent-extension/tests/test-*.js          -> NODE TESTS OK
bash -n Linux_Start.sh switch-project.sh sync-upstream.sh scripts/*.sh -> BASH_SYNTAX_OK
```

## Item status

| # | Item | Status | Evidence / remaining step |
|---|------|--------|---------------------------|
| 1 | Banner disconnected stale | Diagnosed; self-heal path exists | `core/main.js` `onStatus` → `setStatus` clears bridge banner when a fresh status arrives; stale-extension branch stops polling and shows the reload banner. Needs a live check after reload. |
| 2 | Fan-out parallel live | Code done; live verify pending | `bridge.py` per-provider lock + `_prompt_owners`; test `test_fanout_pins_different_providers_in_parallel`. Hidden-tab result loss mitigated by item 3 fix. |
| 3 | Deep task in hidden tab stalls | Code done; live verify pending | `core/main.js` `waitVisible()` and `waitForResponse()` now bypass parking while `a2aCurrentId` is set. Manual sessions keep the opt-in default. |
| 4 | A2A incremental results | Partial | `a2a_server.py`: default timeout 30 min, `metadata.timeoutMs` override, `status.progress.elapsedSeconds` on live tasks; `harness_loop.py` client timeout raised 600 → 1800 s; Hermes example updated. True partial-text streaming is **not** implemented — needs bridge/extension partial-result frames. |
| 5 | `tasks/cancel` | Done | Alias + `TaskStore.cancel()` + cancel events + late-reply guard in `a2a_server.py`; 3 tests in `tests/test_a2a_server.py`. Residual: the browser tab may keep generating until it finishes. |
| 6 | Usage-limit auto-routing | Done | `background.js`: `LIMIT_RE`, `markProviderLimited`, `isProviderLimited`, cooldown persisted to storage; `routeFor()` drops limited providers; explicit pin bypasses. 5 checks in `test-background.js` (app copy mirrored). |
| 7 | Rudder 10 s → "empty reply" | Code done; live verify pending | `core/main.js` final-blank branch now carries `P.scanError()` text as `context_limit` detail instead of a bare `empty`. Needs a live Rudder run to confirm the site notice is present. |
| 8 | Ptero text rejected | Code done; live verify pending | `providers/ptero.js` (both copies): sticky-write retry before waiting for the Send button, mirroring the proven Rudder fix. Node syntax/tests pass; needs a live Ptero run. |
| 9 | `run_tests` pytest missing | Done | `workspace_mcp.py` checks `importlib.util.find_spec("pytest")`, falls back to `python -m unittest discover -s tests`; 2 tests. |
| 10 | `run_project_script` requires package.json | Done | Added `[tool.snapgent.scripts]` fallback in `pyproject.toml`; explicit error when neither manifest defines the script; 2 tests. |
| 11 | `run_command` path containment | Done | `_assert_command_contained()` rejects `..` traversal and out-of-root executables while allowing PATH binaries; absolute *arguments* stay in the mandatory bwrap sandbox so `ls /home` still works. E2E 26/26. |
| 12 | Content-script channel stale after reload | Not fixed — manual | An orphaned content script cannot get a new runtime context. Existing detection shows the reload banner. Real remedy: reload the page/extension (item 22). |
| 13 | Focus stolen → provider park | Mitigated | A2A tasks no longer park on focus loss (item 3). Popup still calls `tabs.update(..., {active:true})` for its Settings action; changing that would hide the menu. Needs a product decision. |
| 14 | Bridge not self-healing | Code added; not activated | `scripts/bridge-supervise.sh` (restart loop) and `scripts/install-bridge-service.sh` (systemd --user unit, env file, enable --now). Requires the user to run one of them. |
| 15 | `a2a_call` Hermes without metadata | Workaround in-repo; plugin unpatched | `scripts/a2a_call.py` always sends `metadata` (provider/tier/category/timeoutMs); docs updated. The external Hermes plugin still needs its own patch — not reachable from this repo. |
| 16 | `a2a_orchestrate` unused | Done | `tasks/orchestrate` alias + fan-out implementation in `a2a_server.py` (first success wins); 2 tests. Documented in `docs/a2a.md`. |
| 17 | Hard-stop PII web search | Done | `bridge.py` `web_search_pii_violations()` enforces the prompt rule at the bridge boundary; prompt-only web-search intent or `metadata.webSearch`; 4 tests. |
| 18 | "Improve for everyone" off | Not possible from code | A site setting. Prompt text tells the model to keep it off; only manual verification on each provider can confirm it. |
| 19 | Bar + composer unified band, orbiting light | Code present; visual verify pending | `overlay.css` `#zs-composer-glow`, `@keyframes zs-orbit`, `#zs-bar.zs-bar-unified`. Not visually checked after reload. |
| 20 | All yellow → blue | Code present; visual verify pending | `overlay.css` semantic blue tokens replace amber/yellow across bar, stop button, menus and chips. Not visually checked after reload. |
| 21 | Input bar default size | Code present; visual verify pending | Type scale raised to a 10.5 px floor / 13 px body. Not visually checked after reload. |
| 22 | Reload extension | Not done — manual | No browser/extension harness in this environment. Required before items 19–21, 24 can be verified. |
| 23 | Formal design review report | Done | `docs/design-review-overlay-2026-11-21.md`, apple-design format, HIG citations and computed contrast ratios. |
| 24 | Bar sticks on all providers | Not done — manual | Needs a live browser with Rudder/Ptero/Gemini/DeepSeek tabs after reload. |
| 25 | git_commit / git_push / git_create_pr | Deliberately skipped | Destructive/external, per the objective. No commits, pushes or PRs made. |

## Files changed this session

Backend: `workspace_mcp.py`, `bridge.py`, `a2a_server.py`
Tests: `tests/test_workspace_mcp.py`, `tests/test_bridge.py`,
`tests/test_a2a_server.py`, `tests/test_a2a_call.py`
Extension: `core/main.js`, `core/config.js` (earlier), `overlay.css`,
`background.js`, `providers/ptero.js` — plus mirrored app copies where required.
Scripts/docs: `scripts/a2a_call.py`, `scripts/bridge-supervise.sh`,
`scripts/install-bridge-service.sh`, `docs/a2a.md`,
`docs/design-review-overlay-2026-11-21.md`, `docs/audit-followup-2026-11-22.md`.

## Risk the user must know

- Items 1, 7, 8, 12, 18, 19–22 and 24 need a real browser after an extension
  reload. This session could only prove code correctness, not visual behaviour.
- The PII guard triggers only on explicit web-search intent (or
  `metadata.webSearch`); a model that searches without saying so is still
  covered only by the prompt-level rule.
- `tasks/cancel` marks the A2A task canceled, but the web tab may keep
  generating until it finishes; only the bridge's own deadline sends a
  `cancel_prompt` to the extension.
- True incremental A2A results (partial text while the model works) remain
  unimplemented. The 30-minute deadline and liveness field are mitigations.
- The systemd/supervisor scripts were syntax-checked but not run; starting a
  service is left to the user.
