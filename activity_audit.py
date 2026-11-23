#!/usr/bin/env python3
"""Structured JSONL activity audit log for Snapgent A2A, bridge, and MCP calls.

Records lifecycle events correlated by ``task_id``, ``prompt_id``,
``context_id``, ``harness``, ``agent_id``, ``session_id``, and ``session_url``
without ever persisting bearer tokens, bridge tokens, cookies, or raw tool
output / workspace file contents.

stdlib only.
"""

import json
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

if os.name == "posix":
    _O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
else:
    _O_NOFOLLOW = 0

ROOT = Path(__file__).resolve().parent
DEFAULT_AUDIT_PATH = ROOT / "logs" / "activity_audit.jsonl"
AUDIT_PATH_ENV = "ZS_AUDIT_LOG"
_DISABLED_VALUES = frozenset({"0", "off", "false", "no"})
_SECRET_QUERY_RE = re.compile(
    r"(token|key|secret|auth|sig|password|apikey|access_token)", re.IGNORECASE
)
_SESSION_HASH_RE = re.compile(r"#/([A-Za-z0-9._:-]{3,128})")
_SESSION_PATH_RE = re.compile(r"/sessions?/([A-Za-z0-9._:-]{3,128})")
MAX_URL_CHARS = 512
MAX_TEXT_CHARS = 300


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def resolve_audit_path() -> Optional[Path]:
    """Return the active JSONL audit path, or ``None`` when audit logging is disabled."""
    raw = os.environ.get(AUDIT_PATH_ENV)
    if raw is None or not raw.strip():
        return DEFAULT_AUDIT_PATH
    cleaned = raw.strip()
    if cleaned.lower() in _DISABLED_VALUES:
        return None
    return Path(cleaned).expanduser()


def sanitize_text(value: Any, limit: int = MAX_TEXT_CHARS) -> str:
    """Collapse newlines and bound arbitrary diagnostic text."""
    if value is None:
        return ""
    text = str(value).replace("\r", " ").replace("\n", " ").strip()
    if len(text) > limit:
        return text[:limit]
    return text


def _redact_query_string(query: str) -> str:
    if not query:
        return ""
    pairs = parse_qsl(query, keep_blank_values=True)
    redacted = [
        (k, "REDACTED" if _SECRET_QUERY_RE.search(k) else v)
        for k, v in pairs
    ]
    return urlencode(redacted)


def sanitize_url(url: Any) -> str:
    """Normalize a URL/referer for logging while redacting sensitive query params."""
    if not isinstance(url, str):
        return ""
    cleaned = url.replace("\r", "").replace("\n", "").strip()
    if not cleaned:
        return ""
    try:
        parts = urlsplit(cleaned)
    except ValueError:
        return sanitize_text(cleaned, MAX_URL_CHARS)
    query = _redact_query_string(parts.query)
    fragment = parts.fragment
    if "?" in fragment:
        frag_path, frag_query = fragment.split("?", 1)
        fragment = f"{frag_path}?{_redact_query_string(frag_query)}"
    netloc = parts.netloc
    if "@" in netloc and parts.hostname:
        host = parts.hostname if ":" not in parts.hostname else f"[{parts.hostname}]"
        netloc = f"{host}:{parts.port}" if parts.port else host
    normalized = urlunsplit((parts.scheme, netloc, parts.path, query, fragment))
    return normalized[:MAX_URL_CHARS]


def _pick_first(mapping: Dict[str, str], keys: Tuple[str, ...]) -> str:
    for key in keys:
        value = mapping.get(key)
        if value:
            return value
    return ""


def _pick_meta(meta: Any, keys: Tuple[str, ...]) -> str:
    if not isinstance(meta, dict):
        return ""
    for key in keys:
        value = meta.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def extract_session_context(
    headers: Optional[Dict[str, str]] = None,
    params: Optional[Dict[str, Any]] = None,
    rpc_id: Any = None,
) -> Dict[str, Any]:
    """Extract sanitized caller harness/session identity from HTTP headers and JSON-RPC params."""
    hdr = {
        str(k).lower(): str(v).strip()
        for k, v in (headers or {}).items()
        if isinstance(k, str) and v is not None and str(v).strip()
    }
    params_dict = params if isinstance(params, dict) else {}
    top_meta = params_dict.get("metadata")
    msg = params_dict.get("message")
    msg_meta = msg.get("metadata") if isinstance(msg, dict) else None

    def pick(header_keys: Tuple[str, ...], meta_keys: Tuple[str, ...]) -> str:
        return (
            _pick_first(hdr, header_keys)
            or _pick_meta(top_meta, meta_keys)
            or _pick_meta(msg_meta, meta_keys)
        )

    harness = sanitize_text(
        pick(("x-harness", "x-agent-harness", "x-caller-harness"), ("harness", "sourceHarness")),
        64,
    )
    agent_id = sanitize_text(
        pick(("x-agent-id", "x-caller", "x-agent"), ("agentId", "agent_id", "caller", "agent")),
        128,
    )
    session_id = sanitize_text(
        pick(
            ("x-session-id", "x-hermes-session-id", "x-run-id"),
            ("sessionId", "session_id", "runId", "run_id"),
        ),
        128,
    )
    session_url = sanitize_url(
        pick(
            ("x-session-url", "x-session-link", "referer"),
            ("sessionUrl", "session_url", "sessionLink", "session_link"),
        )
    )
    if session_url:
        if not harness and "hermes" in session_url.lower():
            harness = "hermes"
        if not session_id:
            match = _SESSION_HASH_RE.search(session_url) or _SESSION_PATH_RE.search(session_url)
            if match:
                session_id = sanitize_text(match.group(1), 128)

    requested_ctx = ""
    if isinstance(msg, dict) and isinstance(msg.get("contextId"), str):
        requested_ctx = sanitize_text(msg["contextId"], 128)

    raw = {
        "harness": harness,
        "agent_id": agent_id,
        "session_id": session_id,
        "session_url": session_url,
        "requested_context_id": requested_ctx,
        "rpc_id": sanitize_text(rpc_id, 64) if rpc_id is not None else "",
        "user_agent": sanitize_text(hdr.get("user-agent"), 160),
        "a2a_version": sanitize_text(hdr.get("a2a-version"), 32),
        "client_ip": sanitize_text(hdr.get("_client_ip"), 64),
    }
    return {k: v for k, v in raw.items() if v}


class ActivityAuditLog:
    """Append-only 0600 JSONL audit writer with thread-safe emission and tail filtering."""

    def __init__(self, path: Optional[Path] = None, enabled: bool = True) -> None:
        self._fixed_path = Path(path) if path is not None else None
        self._enabled = enabled
        self._lock = threading.Lock()

    @property
    def path(self) -> Optional[Path]:
        if not self._enabled:
            return None
        return self._fixed_path if self._fixed_path is not None else resolve_audit_path()

    def record(self, event: str, **fields: Any) -> Optional[Dict[str, Any]]:
        """Append one structured audit entry and return it, or ``None`` if disabled/unwritable."""
        target = self.path
        if target is None or not event:
            return None
        entry: Dict[str, Any] = {"ts": _now_iso(), "event": sanitize_text(event, 96)}
        for key, value in fields.items():
            if value is None or value == "":
                continue
            entry[key] = value
        line = json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n"
        with self._lock:
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                fd = os.open(
                    target,
                    os.O_WRONLY | os.O_CREAT | os.O_APPEND | _O_NOFOLLOW,
                    0o600,
                )
                try:
                    os.write(fd, line.encode("utf-8"))
                finally:
                    os.close(fd)
                try:
                    os.chmod(target, 0o600)
                except OSError:
                    pass
            except OSError:
                return None
        return entry

    def tail(
        self,
        limit: int = 50,
        session_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Read the most recent matching audit records (up to ``limit``)."""
        target = self.path
        if target is None or limit <= 0:
            return []
        try:
            with self._lock:
                raw_lines = target.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            return []
        matched: List[Dict[str, Any]] = []
        for raw in raw_lines:
            if not raw.strip():
                continue
            try:
                item = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(item, dict):
                continue
            if session_id and item.get("session_id") != session_id:
                continue
            if task_id and item.get("task_id") != task_id:
                continue
            matched.append(item)
        return matched[-limit:]


_DEFAULT_LOG = ActivityAuditLog()


def get_audit_log() -> ActivityAuditLog:
    """Return the shared process-wide ``ActivityAuditLog`` instance."""
    return _DEFAULT_LOG
