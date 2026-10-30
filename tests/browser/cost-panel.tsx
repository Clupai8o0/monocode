import { createRoot } from "react-dom/client";
import { CostView } from "../../src/fork/cost/CostPanel";
import type { CostReport } from "../../src/fork/cost/costModel";
import "../../src/styles/index.css";

const params = new URLSearchParams(location.search);
if (params.get("theme") === "light") {
  document.documentElement.classList.add("theme-light");
}
const TODAY = "2026-10-31";
const DAY_MS = 86_400_000;

// A realistic shape: quiet weekends, Opus doing most of it, Sonnet and Haiku less.
const days = Array.from({ length: 56 }, (_, back) => {
  const at = Date.parse(`${TODAY}T00:00:00Z`) - back * DAY_MS;
  const weekend = [0, 6].includes(new Date(at).getUTCDay());
  const swing = 0.6 + ((back * 37) % 11) / 10;
  const scale = (weekend ? 0.25 : 1) * swing;
  return {
    date: new Date(at).toISOString().slice(0, 10),
    byFamily: {
      opus: 42 * scale,
      sonnet: 11 * scale,
      haiku: 1.6 * scale,
      ...(back % 9 === 0 ? { fable: 18 * scale } : {}),
    },
    savedUsd: 96 * scale,
  };
});
const report: CostReport = {
  days,
  models: [
    { model: "claude-opus-5-5", family: "opus", usd: 1538, savedUsd: 4410, inputTokens: 9e6, outputTokens: 41e6, cacheReadTokens: 12e9, cacheWriteTokens: 2e8 },
    { model: "claude-sonnet-5-5", family: "sonnet", usd: 402, savedUsd: 690, inputTokens: 4e6, outputTokens: 22e6, cacheReadTokens: 3e9, cacheWriteTokens: 8e7 },
    { model: "claude-fable-5-1", family: "fable", usd: 118, savedUsd: 210, inputTokens: 1e6, outputTokens: 12e5, cacheReadTokens: 8e8, cacheWriteTokens: 1e7 },
    { model: "claude-haiku-5-5", family: "haiku", usd: 57, savedUsd: 21, inputTokens: 3e6, outputTokens: 18e6, cacheReadTokens: 1e9, cacheWriteTokens: 2e7 },
  ],
  accounts: { main: 1244, cx: 871 },
  unpriced: [],
  unreadable: 0,
};
const empty: CostReport = { days: [], models: [], accounts: {}, unpriced: [], unreadable: 0 };

createRoot(document.getElementById("root")!).render(
  <div className="flex items-start gap-6 p-6 text-content">
    <div data-shot="cost" className="w-[316px]">
      <CostView report={report} today={TODAY} />
    </div>
    <div data-shot="empty" className="w-[316px]">
      <CostView report={empty} today={TODAY} />
    </div>
  </div>,
);
