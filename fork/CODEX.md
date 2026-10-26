# Codex in MonoCode

Codex uses MonoCode's composer and app controls; Claude-only terminal commands are not interchangeable.

| Ability | How it works |
|---|---|
| Effort | Select it in the composer model picker; each interactive turn now also receives the value MonoCode submits. |
| Mentions and skills | Use `@` for file references and `/` for skills; both were already supported. |
| Session communication | Enable `/operator` for project-scoped session listing, reading and follow-ups; recipients must be idle and cannot have broader permissions than the sender. Agent launches also stay within the sender's permissions. |
| Monos | With `/operator`, `monocode app monos.list` finds this project's Monos; `monos.configure` creates or updates one and its habits when you ask, such as a daily project review. Suggestions alone do not schedule work. |
| Project logos | With `/operator` enabled, `monocode app projects.logo.set --json '{"path":"assets/logo.svg","background":"transparent"}'` applies an image inside this project; `projects.logo.clear` restores the mascot. |
| Message cards | Received cross-session envelopes now render in Codex; explicit Codex senders use the Codex icon. |
| Sent-message badges | Successful MCP `SendMessage` receipts count; native Codex child-agent messages do not count as messages to independent sessions. |
| Artifact links | Existing `claude.ai` artifact-link chips now appear in Codex conversations too, without running Claude's status script. |
| Phone access | Settings → Connections → Your phones; needs pairing, the MonoCode mobile app, and an awake desktop. |

- Native Codex collaboration remains limited to its agent tree; this change does not add Claude's cross-session transport.
- A stale developer-level effort hook can override the new user-level host context; shared hook files were not changed.
- The iPhone app currently requires a TestFlight invitation; no phone was paired or remote access enabled by this change.
- Mono configuration needs Monos enabled and stays within the current local project; new Monos inherit the session's model and permissions, and habits run while MonoCode is open using normal provider allowance.
- Agents can configure a habit's instructions at their current permission level; replacing a Mono's shared standing instructions requires Full access because they affect all its future work.

Protocol reference: [OpenAI app-server documentation](https://learn.chatgpt.com/docs/app-server).
