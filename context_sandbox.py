#!/usr/bin/env python3
"""Build the per-task context sandbox for the A2A bridge.

A prompt that carries ``metadata.contextFiles`` gets exactly those files: they
are copied into a task directory under ``ZS_CONTEXT_DIR`` (default
``<repo>/.snapgent/context``) and rendered into a bounded context block that is
prepended to the prompt. The web chat therefore starts from the files the
caller named, instead of the whole repository.

Paths are relative to the repository root. Absolute paths, ``..`` segments and
symlinks that resolve outside the root are rejected, not followed.

stdlib only.
"""

import shutil
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

DEFAULT_MAX_FILES = 50
DEFAULT_MAX_FILE_BYTES = 64 * 1024
DEFAULT_MAX_BYTES = 256 * 1024


class ContextSandboxError(ValueError):
    """A requested context file is not safe to read."""


def _safe_relpath(raw: Any, root: Path) -> Path:
    if not isinstance(raw, str) or not raw.strip():
        raise ContextSandboxError("empty path")
    candidate = Path(raw.strip())
    if candidate.is_absolute() or candidate.drive:
        raise ContextSandboxError("absolute paths are not allowed")
    if any(part in ("..", "") for part in candidate.parts):
        raise ContextSandboxError("parent segments are not allowed")
    resolved = (root / candidate).resolve()
    if resolved != root and root not in resolved.parents:
        raise ContextSandboxError("path escapes the repository root")
    return candidate


def _safe_task_id(task_id: str) -> str:
    cleaned = "".join(ch for ch in str(task_id) if ch.isalnum() or ch in "-_")
    return cleaned or "task"


def _render(entries: List[Dict[str, Any]]) -> str:
    if not entries:
        return ""
    lines = [
        "[CONTEXT SANDBOX]",
        "Only the files below are provided for this task.",
        "Do not read other repository files; work from this context.",
    ]
    for entry in entries:
        lines.append(f"--- {entry['path']} ({entry['bytes']} bytes) ---")
        lines.append(entry["text"])
        lines.append(f"--- END {entry['path']} ---")
    lines.append("[END CONTEXT SANDBOX]")
    return "\n".join(lines)


def prepare(
    files: Iterable[Any],
    task_id: str,
    root: Path,
    dest_root: Optional[Path] = None,
    max_files: int = DEFAULT_MAX_FILES,
    max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
    max_bytes: int = DEFAULT_MAX_BYTES,
) -> Dict[str, Any]:
    """Copy the requested files and return a manifest plus the prompt block.

    Missing, oversized or unsafe entries are reported in ``skipped``; they never
    abort the whole task unless every entry was skipped, which the caller can
    treat as an error.
    """
    root = Path(root).resolve()
    dest_root = Path(dest_root) if dest_root is not None else root / ".snapgent" / "context"
    dest = (dest_root / _safe_task_id(task_id)).resolve()
    dest.mkdir(parents=True, exist_ok=True)

    copied: List[str] = []
    skipped: List[Dict[str, str]] = []
    entries: List[Dict[str, Any]] = []
    total = 0

    for raw in list(files)[:max_files]:
        try:
            rel = _safe_relpath(raw, root)
        except ContextSandboxError as error:
            skipped.append({"path": str(raw), "reason": str(error)})
            continue
        source = (root / rel).resolve()
        if not source.is_file():
            skipped.append({"path": rel.as_posix(), "reason": "not a file"})
            continue
        try:
            size = source.stat().st_size
        except OSError as error:
            skipped.append({"path": rel.as_posix(), "reason": str(error)})
            continue
        if size > max_file_bytes:
            skipped.append({"path": rel.as_posix(), "reason": f"larger than {max_file_bytes} bytes"})
            continue
        if total + size > max_bytes:
            skipped.append({"path": rel.as_posix(), "reason": f"total context would exceed {max_bytes} bytes"})
            continue
        target = dest / rel
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            text = source.read_text(encoding="utf-8", errors="replace")
        except OSError as error:
            skipped.append({"path": rel.as_posix(), "reason": str(error)})
            continue
        copied.append(rel.as_posix())
        entries.append({"path": rel.as_posix(), "bytes": size, "text": text})
        total += size

    return {
        "root": str(dest),
        "files": copied,
        "skipped": skipped,
        "bytes": total,
        "context": _render(entries),
    }
