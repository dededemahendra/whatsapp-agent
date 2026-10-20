# whatsapp-agent

An MCP server and command line tool that lets AI agents read, search and send WhatsApp on your own number, through [wacli](https://github.com/openclaw/wacli). Writes are off until you turn them on, every send can require your confirmation, and everything the agent sends is written to an audit log.

Works with Claude Code, Claude Desktop, Cursor and any other MCP host.

## Before you start

wacli and this tool use the WhatsApp Web protocol through an unofficial client. WhatsApp's terms prohibit that, and accounts have been warned or banned even at low volume. Use a number you can afford to lose, never use this for bulk or cold messages, and keep the rate limit on.

## Install

1. Install wacli (macOS or Linux):

   ```
   brew install openclaw/tap/wacli
   ```

2. Install whatsapp-agent globally and run setup:

   ```
   npm i -g whatsapp-agent
   whatsapp-agent setup
   ```

   Setup checks wacli, pairs WhatsApp by showing a QR code to scan from your phone (Settings, Linked devices), writes a policy with writes off, offers to install the background sync daemon, and prints the host configuration.

   `setup` accepts `--service`, `--no-service` and `--install-wacli` to answer its questions without prompting, which is what a non-interactive shell needs.

3. Connect your agent host:

   ```
   claude mcp add --scope user whatsapp -- npx -y whatsapp-agent mcp
   ```

   For Claude Desktop or Cursor, add to the host's MCP settings:

   ```json
   { "mcpServers": { "whatsapp": { "command": "npx", "args": ["-y", "whatsapp-agent", "mcp"] } } }
   ```

Requires Node 22.12 or newer and wacli 0.22.0 or newer.

## What the agent can do

Read tools, always available:

| Tool | Purpose |
| --- | --- |
| `whatsapp_status` | Pairing state, last sync, last activity, policy summary |
| `list_chats` | Chats with unread counts |
| `read_messages` | One page of a conversation, oldest first, with a cursor for older pages |
| `search_messages` | Full-text search with chat, sender, media and date filters |
| `get_message_context` | Messages around one message |
| `find_contacts` | Contacts by name, alias or number |
| `list_groups`, `get_group` | Groups and their participants |
| `download_media` | Save an attachment into whatsapp-agent's own folder; small images are returned inline |

Write tools, governed by the policy:

| Tool | Purpose |
| --- | --- |
| `send_text` | Text message, with quoting and mentions |
| `send_file` | A file from an allowed folder |
| `react` | Emoji reaction |
| `mark_read` | Mark a chat read |

The package ships `SKILL.md`, a short guide to reading and sending carefully. Copy it to `~/.claude/skills/whatsapp-agent/SKILL.md` for Claude Code, or wherever your agent loads skills from. After a global install the file is at $(npm root -g)/whatsapp-agent/SKILL.md.

## Policy

The policy lives at `~/.config/whatsapp-agent/policy.json`. Manage it from the command line:

```
whatsapp-agent policy show
whatsapp-agent policy enable              # turn write tools on
whatsapp-agent policy set confirm always  # always | unlisted | never
whatsapp-agent policy allow "+61 400 000 001"
whatsapp-agent policy remove "+61 400 000 001"  # remove an allowlist entry; a name is looked up the same way as for allow
whatsapp-agent policy set groups on
whatsapp-agent policy add-file-root ~/Outbox
whatsapp-agent policy disable
```

- `confirm always` (default): the agent's host shows you the recipient and the exact text, and nothing is sent until you tick confirm. Hosts that cannot show a form get a clear refusal instead.
- `confirm unlisted`: allowlisted recipients send without a prompt; everyone else prompts.
- `confirm never`: no prompts at all. The allowlist is not consulted in this mode.
- Allowlist entries are phone numbers or JIDs. `policy allow <name>` looks the name up once and stores the JID. Display names are never matched, because other people choose them.
- Groups are refused until `set groups on`.
- `send_file` is off until you add a folder.
- Validation errors for malformed tool input come back from the MCP SDK as plain text; only tool-level errors carry the `{"error", "message"}` JSON shape.
- Rate limit: 20 sends an hour and 5 seconds between sends by default.

Changes take effect on the next tool call; no restart needed. The exceptions are the limits, account and daemon blocks of policy.json, which are read at start: restart the MCP server (reconnect your host), and for the daemon run `whatsapp-agent daemon install` again, which restarts the service.

The commands that widen what the agent may send (`enable`, `set confirm unlisted` and `never`, `set groups on`, `allow` and `add-file-root`) refuse to run unless stdin is a terminal. `show`, `disable`, `set confirm always`, `set groups off` and `remove` run anywhere.

The controls assume the agent cannot run commands as your user. An agent with a shell as the same user could change the policy or call wacli itself, so keep the policy commands for yourself, and run such agents under a different user if you need a hard boundary.

## Audit

```
whatsapp-agent audit            # last 50 records
whatsapp-agent audit -n 200     # 200 records instead of the default 50
whatsapp-agent audit --since 2026-10-01 --tool send_text
whatsapp-agent audit --json     # one JSON record per line
```

Every attempt is recorded, including refused ones, with recipient, outcome and the text that was sent. The file is owner-only at `~/.local/share/whatsapp-agent/audit.jsonl`.

## Background sync

The agent reads from wacli's local mirror. Keep it fresh with the daemon:

```
whatsapp-agent daemon install   # launchd on macOS, systemd on Linux
whatsapp-agent daemon status
whatsapp-agent daemon logs -f
whatsapp-agent daemon logs -n 200  # last 200 lines (default 100)
whatsapp-agent daemon uninstall
```

`daemon install` needs a global install. On other platforms run `whatsapp-agent daemon run` under your own supervisor.

## Troubleshooting

Run `whatsapp-agent doctor`. It prints wacli's version, pairing state, the daemon, the policy and the paths, and lists anything that needs attention with the command to fix it. Use `whatsapp-agent doctor --json` for the same report as JSON.

Common cases:

- Not paired, or the session was revoked: run `whatsapp-agent setup` and scan the QR code again.
- After re-pairing, restart the daemon with `whatsapp-agent daemon install`.
- The sync daemon is not installed: `npm i -g whatsapp-agent` then `whatsapp-agent daemon install`.
- Reads look stale: `whatsapp-agent daemon status`, then `daemon logs`.
- `confirmation_unavailable`: your host cannot show a confirmation form. Allowlist the recipient and set `confirm unlisted`.
- Slow first tool call: npx downloads the package. A global install avoids it.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `WHATSAPP_AGENT_WACLI_BIN` | Path to wacli (default: `wacli` on PATH) |
| `WHATSAPP_AGENT_CONFIG_DIR` | Policy location (default `~/.config/whatsapp-agent`). The value is made absolute, and `~` is accepted |
| `WHATSAPP_AGENT_DATA_DIR` | Media, audit and rate-limit state (default `~/.local/share/whatsapp-agent`). The value is made absolute, and `~` is accepted |
| `WHATSAPP_AGENT_ALLOW_LOCAL_SERVICE` | `1` lets `daemon install` run from a checkout that is not a global install |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME` | Used for the defaults above when the specific overrides are unset |
| `WHATSAPP_AGENT_LOG` | `debug` prints diagnostics on stderr (never message text) |

## Development

```
pnpm install
pnpm test        # unit and integration tests against a fake wacli
pnpm typecheck
pnpm build
pnpm test:smoke  # read-only checks against your real paired wacli
```

## Licence

MIT. Not affiliated with WhatsApp or Meta.
