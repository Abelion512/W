"""Session-wide test fixtures for the WebMCP test suite."""

import os
import pytest
import activity_audit


@pytest.fixture(autouse=True, scope="session")
def isolate_activity_audit_log(tmp_path_factory):
    """Redirect activity audit logging during pytest so live logs stay clean."""
    tmp_dir = tmp_path_factory.mktemp("audit")
    audit_path = tmp_dir / "activity_audit.jsonl"
    prev_value = os.environ.get(activity_audit.AUDIT_PATH_ENV)
    os.environ[activity_audit.AUDIT_PATH_ENV] = str(audit_path)
    activity_audit._DEFAULT_LOG = activity_audit.ActivityAuditLog()
    try:
        yield audit_path
    finally:
        if prev_value is None:
            os.environ.pop(activity_audit.AUDIT_PATH_ENV, None)
        else:
            os.environ[activity_audit.AUDIT_PATH_ENV] = prev_value
        activity_audit._DEFAULT_LOG = activity_audit.ActivityAuditLog()
