# Codex in MonoCode

Codex uses MonoCode's composer and app controls; Claude-only terminal commands are not interchangeable.

| Ability | How it works |
|---|---|
| Effort | Select it in the composer model picker; each interactive turn now also receives the value MonoCode submits. |
| Mentions and skills | Use `@` for file references and `/` for skills; both were already supported. |
| Session communication | Enable `/operator` for project-scoped session listing, reading and follow-ups; recipients must be idle. |
| Message cards | Received cross-session envelopes now render in Codex; explicit Codex senders use the Codex icon. |
| Sent-message badges | Successful MCP `SendMessage` receipts count; native Codex child-agent messages do not count as messages to independent sessions. |
| Artifact links | Existing `claude.ai` artifact-link chips now appear in Codex conversations too, without running Claude's status script. |
| Phone access | Settings → Connections → Your phones; needs pairing, the MonoCode mobile app, and an awake desktop. |

- Native Codex collaboration remains limited to its agent tree; this change does not add Claude's cross-session transport.
- A stale developer-level effort hook can override the new user-level host context; shared hook files were not changed.
- The iPhone app currently requires a TestFlight invitation; no phone was paired or remote access enabled by this change.

Protocol reference: [OpenAI app-server documentation](https://learn.chatgpt.com/docs/app-server).
