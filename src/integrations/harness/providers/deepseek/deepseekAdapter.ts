import {
  bindDeepSeekSession,
  cancelDeepSeekTurn,
  forgetDeepSeekSession,
  respondDeepSeekApproval,
  sendDeepSeekTurn,
  steerDeepSeekTurn,
  stopDeepSeekSession,
} from "./deepseek";
import { refreshDeepSeekCatalog } from "./deepseekCatalog";
import { registerHarness, type HarnessAdapter } from "../../core/registry";

export const deepseekAdapter: HarnessAdapter = {
  id: "deepseek",
  live: true,
  canSteer: false,
  sendTurn: sendDeepSeekTurn,
  steerTurn: steerDeepSeekTurn,
  cancelTurn: cancelDeepSeekTurn,
  respondApproval: respondDeepSeekApproval,
  stopSession: stopDeepSeekSession,
  forgetSession: forgetDeepSeekSession,
  bindSession: bindDeepSeekSession,
  refreshCatalog: refreshDeepSeekCatalog,
};

let registered = false;

export function ensureDeepSeekRegistered(): void {
  if (registered) return;
  registerHarness(deepseekAdapter);
  registered = true;
}
