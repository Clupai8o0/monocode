# Automatic Claude and Codex accounts

New sessions default to the profile with the most remaining allowance; explicit account choices still apply.

- Enable the existing Auto picker and usage probes for Codex as well as Claude.
- After a confirmed usage limit, probe other profiles and use the existing conversation transfer and continuation flow.
- Keep model, effort, access mode and plan intent; never switch while a turn, question or workspace move is pending.
- Remember actual limit failures until their reset, so lagging usage meters cannot cause repeated switches.
- If no usable profile is known, keep the session paused with its existing manual recovery controls.
- Verify account selection, recovery, cancellation and failed probes with tests, type checking and independent review.

The Cursor screenshot is a separate missing working-directory error: the saved worktree folder no longer exists.
