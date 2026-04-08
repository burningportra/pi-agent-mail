# pi-agent-mail

Agent Mail coordination tools for every [pi](https://github.com/mariozechner/pi-mono) session.

Bootstraps an agent identity on startup and registers tools for messaging, inbox, file reservations, and thread coordination. Injects urgent unread messages into the system prompt so the agent sees pending mail before each turn. Releases all file reservations cleanly on exit.

Requires [Agent Mail](https://github.com/mcp-agent-mail/mcp-agent-mail) server running (`am`).

## Tools

| Tool | Description |
|------|-------------|
| `am_whoami` | Show your current agent identity |
| `am_inbox` | Fetch inbox (filter by urgency, include bodies) |
| `am_send` | Send a message to agents or broadcast to all |
| `am_reply` | Reply to a message by ID |
| `am_ack` | Acknowledge a message that required it |
| `am_search` | Full-text search across all messages |
| `am_reserve` | Reserve files before editing (conflict prevention) |
| `am_release` | Release file reservations when done |
| `am_prepare_thread` | Join an existing thread and get its history |

## What happens automatically

- **`session_start`** — calls `macro_start_session`, gets an auto-generated identity (e.g. `GrayDog`), fetches inbox
- **`before_agent_start`** — injects urgent unread messages into the system prompt
- **`session_shutdown`** — releases all file reservations

## Install

```bash
# 1. Clone
git clone https://github.com/burningportra/pi-agent-mail /path/to/pi-agent-mail

# 2. Add to ~/.pi/agent/settings.json
{
  "packages": [
    "/path/to/pi-agent-mail",
    ...
  ]
}
```

## Usage

Once installed, you'll see on startup:
```
[pi-agent-mail] GrayDog @ /your/project
```

The agent can then use the tools directly:

```
# Check inbox
am_inbox()

# Send to another agent
am_send(to=["BlueLake"], subject="Done with auth", body="PR is ready")

# Reserve files before editing
am_reserve(paths=["src/auth/**/*.ts"], reason="bd-42")
# ... edit files ...
am_release()

# Join a thread
am_prepare_thread(thread_id="bd-42")
```

## License

MIT
