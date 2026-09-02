"""Retired compatibility launcher; it always fails closed.

Current Proto Workbench packages only the admin CLI and MCP sidecars. Model
catalogue and lifecycle operations belong exclusively to LM Studio at the fixed
loopback endpoint documented in ``apps/proto-workbench/README.md``.
"""

from proto_agent.workbench_bridge import main


if __name__ == "__main__":
    raise SystemExit(main())
