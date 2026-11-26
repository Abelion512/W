# AGENTS.md - webmcp
Inherits `/media/abelion/Isaf/ican/project/AGENTS.md` and `/home/abelion/.config/ai-policy/GLOBAL_CONSTITUTION.md`. This file only pins repo facts.

- Runtime: Python stdlib + `websockets` only. No other runtime dependency.
- Imports: `workspace_mcp`, `bridge` (and siblings) resolve from repo root. Keep root importable.
- Tests: pytest in `tests/` (`/usr/bin/python3 -m pytest -q`); Node stub-DOM tests in `snapgent-extension/tests/`; live e2e in `e2e/` needs Chrome, run only when relevant.
- Layout: flat root for runtime modules, tests in `tests/`, e2e in `e2e/`, docs in `docs/`. See `docs/code-standards.md` for naming, size, and CI checks.
- JS: core in `snapgent-extension/core/`, per-site adapters in `providers/`. Do not add new subsystems to `core/main.js`.
- Avoid: full e2e/A2A matrix runs before a change is stable; broad rewrites of large files; new dependencies without a reason.
- Style: ponytail ultra + caveman ultra. Effort Medium by default, High only when stuck.
