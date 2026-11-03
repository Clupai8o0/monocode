/** Identities used by the score row without loading table strategies or chatter. */
export const AGENT_NAMES = {
  claude: "Claude",
  codex: "Codex",
  deepseek: "DeepSeek",
  gemini: "Gemini",
  grok: "Grok",
  muse: "Muse",
  kimi: "Kimi",
} as const;

export type AgentId = keyof typeof AGENT_NAMES;
export const AGENT_IDS: readonly AgentId[] = Object.keys(AGENT_NAMES) as AgentId[];
