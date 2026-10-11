import { promptBlocks, type PromptContentBlock } from "../../../../features/sessions/model/attachments";
import type { AgentModel, ModelSetting } from "../../../../features/sessions/model/models";
import type { Attachment } from "../../../../features/sessions/model/session";

/** DeepSeek Harness (`dsh`) speaks standard ACP v1 through its `acp` profile. */
export const DEEPSEEK_ACP_ARGS = ["--profile", "acp"];

export const DEEPSEEK_AUTH_HELP =
  "Set up DeepSeek Harness with `dsh` (add an API key), then retry.";

export type DeepSeekConfigChoice = { value: string; name: string };

export type DeepSeekConfigOption = {
  id: string;
  currentValue: string;
  choices: DeepSeekConfigChoice[];
};

/**
 * dsh takes text and resource links; it accepts images only on a vision model
 * route and rejects them otherwise, which surfaces as a turn error.
 */
export function deepseekPromptBlocks(
  text: string,
  attachments: Attachment[] = [],
): PromptContentBlock[] {
  return promptBlocks(text, attachments);
}

export function deepseekSessionId(result: unknown): string | undefined {
  const id = asRecord(result)?.sessionId;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

/**
 * dsh advertises `model` and `reasoning_effort` as ACP config options. Model
 * choices are grouped by provider, so flatten the groups.
 */
export function deepseekConfigOptions(result: unknown): DeepSeekConfigOption[] {
  const raw = asRecord(result)?.configOptions;
  if (!Array.isArray(raw)) return [];
  const out: DeepSeekConfigOption[] = [];
  for (const item of raw) {
    const rec = asRecord(item);
    const id = typeof rec?.id === "string" ? rec.id : "";
    if (!rec || !id) continue;
    out.push({
      id,
      currentValue: String(rec.currentValue ?? ""),
      choices: flattenChoices(rec.options),
    });
  }
  return out;
}

function flattenChoices(value: unknown): DeepSeekConfigChoice[] {
  if (!Array.isArray(value)) return [];
  const out: DeepSeekConfigChoice[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    if (!rec) continue;
    if (Array.isArray(rec.options)) {
      out.push(...flattenChoices(rec.options));
      continue;
    }
    const choice = String(rec.value ?? "").trim();
    if (!choice) continue;
    out.push({ value: choice, name: String(rec.name ?? choice).trim() || choice });
  }
  return out;
}

/**
 * dsh model values are JSON pairs such as `["deepseek-official","deepseek-v4-pro"]`.
 * MonoCode keeps a readable `provider/model` id and maps it back on send.
 */
export function deepseekNativeModelId(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed.every((part) => typeof part === "string" && part)
    ) {
      return `${parsed[0]}/${parsed[1]}`;
    }
  } catch {
    // Not a pair; fall through and use the raw value.
  }
  return value;
}

export function deepseekModelValue(
  nativeId: string,
  choices: DeepSeekConfigChoice[],
): string | undefined {
  return choices.find(
    (choice) =>
      choice.value === nativeId || deepseekNativeModelId(choice.value) === nativeId,
  )?.value;
}

export function modelsFromDeepSeekSession(result: unknown): AgentModel[] {
  const options = deepseekConfigOptions(result);
  const model = options.find((option) => option.id === "model");
  if (!model) return [];
  const effort = options.find((option) => option.id === "reasoning_effort");
  const settings: ModelSetting[] | undefined =
    effort && effort.choices.length > 0
      ? [
          {
            id: "effort",
            label: "Reasoning",
            kind: "select",
            value: effort.currentValue || effort.choices[0].value,
            options: effort.choices.map((choice) => ({
              value: choice.value,
              label: choice.name,
            })),
          },
        ]
      : undefined;

  const seen = new Set<string>();
  const models: AgentModel[] = [];
  for (const choice of model.choices) {
    const nativeId = deepseekNativeModelId(choice.value);
    if (seen.has(nativeId)) continue;
    seen.add(nativeId);
    models.push({
      id: `deepseek:${nativeId}`,
      harness: "deepseek",
      name: choice.name.replace(/-/g, " "),
      nativeId,
      ...(settings ? { settings } : {}),
    });
  }

  // The profile's default model is the right default for a new session.
  const current = deepseekNativeModelId(model.currentValue);
  const index = models.findIndex((entry) => entry.nativeId === current);
  if (index > 0) models.unshift(...models.splice(index, 1));
  return models;
}

const TOOL_KINDS: Record<string, string> = {
  bash: "execute",
  shell: "execute",
  write: "edit",
  edit: "edit",
  multiedit: "edit",
  apply_patch: "edit",
  read: "read",
  grep: "search",
  glob: "search",
  ls: "search",
  list: "search",
  webfetch: "fetch",
  fetch: "fetch",
  websearch: "fetch",
};

/**
 * dsh tags every tool call `other` and names the tool in `title` (`write`,
 * `bash`, ...). Give the shared ACP parser a real kind so rows get the right
 * icon, preview, and approval policy.
 */
export function withDeepSeekToolKind(params: unknown): unknown {
  const envelope = asRecord(params);
  const update = asRecord(envelope?.update);
  if (!envelope || !update) return params;
  if (update.sessionUpdate !== "tool_call") return params;
  if (update.kind && update.kind !== "other") return params;
  const title = typeof update.title === "string" ? update.title.toLowerCase() : "";
  const kind = TOOL_KINDS[title];
  return kind ? { ...envelope, update: { ...update, kind } } : params;
}

export function deepseekStartupError(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  if (/auth|credential|api key|unauthori[sz]ed|401/i.test(detail)) {
    return new Error(`${detail.trim()}\n\n${DEEPSEEK_AUTH_HELP}`);
  }
  if (/timed out/i.test(detail)) {
    return new Error(`DeepSeek Harness did not start. ${DEEPSEEK_AUTH_HELP}`);
  }
  return new Error(`DeepSeek Harness did not start. ${detail}`);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
