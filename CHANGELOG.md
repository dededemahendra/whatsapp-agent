# Changelog

## 0.1.0 (unreleased)

First release.

- MCP server over stdio with read tools (status, chats, messages, search, context, contacts, groups, media) and policy-gated write tools (send text, send file, react, mark read).
- Policy with writes off by default, confirmation through MCP elicitation, allowlist, group opt-in, rate limit, file roots and an audit log.
- Operator CLI: setup, doctor, policy, audit, daemon (run, install, uninstall, status, logs), mcp.
- Launchd and systemd service templates for the sync daemon.
