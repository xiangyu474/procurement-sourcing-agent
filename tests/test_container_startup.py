"""Import-surface test: the container process must be able to start.

A failure here means the image exits immediately on boot, which is only
visible as an opaque container start failure in the cloud.
"""

import subprocess
import sys


def test_container_app_imports_cleanly():
    result = subprocess.run(
        [sys.executable, "-c", "from procurement_agent.api.app import app; print(app.title)"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "Procurement Sourcing Agent Container" in result.stdout
