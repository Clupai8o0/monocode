# Cursor connection recovery

Cursor ACP can report a network failure as a final assistant error chunk followed by a successful `end_turn` response. MonoCode recognizes the exact known timeout/stall diagnostics and makes at most one continuation in the same process and conversation.

| Condition | Behavior |
| --- | --- |
| The prompt made progress and all observed tools have settled | Ask Cursor to check the last request, workspace, diff, and completed tool effects before continuing remaining work. |
| A tool, child tool, background agent, approval, or question is unresolved, or no progress was observed | Surface an error and ask the user to check results before continuing; edits remain in place. |
| A second transport failure, incomplete continuation, or rejected prompt RPC | Surface the error and stop automatically continuing. |
| A diagnostic interrupts the turn and recovery cannot finish | Reject requests already queued behind it; the user can check results and submit a new turn. |
| An error is quoted in longer text or followed by parent assistant text or a new parent tool call | Keep it as ordinary assistant text; late usage or mode updates preserve the diagnostic. |
| User cancels | Submit no further continuation and emit no completion or error for the cancelled prompt. |

Automatic continuation preserves the process, conversation, model, settings, runtime permissions, Plan mode, and turn queue; it never replays the original request or switches providers.

When an error requires manual action, the app stops ACP and pauses queued work. A later user retry starts ACP and loads the saved conversation. Check unfinished command results first: stopping ACP does not confirm every command it started has exited. Missing terminal tool updates conservatively block automatic continuation.
