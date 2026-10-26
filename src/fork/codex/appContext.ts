/** Host facts for interactive Codex turns, separate from the user's request. */
export function codexAppContext(
  effort: string | undefined,
  controlsAgents: boolean,
): string {
  const level = effort?.trim();
  return [
    "<monocode_context>",
    "You are running inside MonoCode's desktop app, through Codex app-server.",
    level
      ? `MonoCode supplied reasoning effort ${JSON.stringify(level)} for this turn. Use this current turn setting when reporting effort; a hook reading a previous rollout or config.toml can be stale.`
      : "MonoCode did not override reasoning effort for this turn. Do not invent an effective level.",
    "The user changes effort with the composer model/effort picker. Do not tell them to restart a terminal or use Claude's /effort command, and do not change effort yourself.",
    "The composer supports @ file references and / skills. Questions, approvals and follow-up messages are shown in the app.",
    controlsAgents
      ? "App control is enabled for this session. Use only the MonoCode control instructions and project scope already supplied; native Codex collaboration tools address your own agent tree."
      : "Independent MonoCode sessions can be coordinated through /operator when the user enables it. Native Codex collaboration tools address your own agent tree; do not assume they reach unrelated Claude or Codex sessions.",
    "Phone access uses MonoCode Settings > Connections > Your phones, subject to pairing and mobile-app availability. Claude's /remote-control is not a command of this app-server session. Do not enable remote access on the user's behalf without their request.",
    "</monocode_context>",
  ].join("\n");
}
