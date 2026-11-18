import { homeDir } from "../../../../platform/tauri/fs";
import {
  antigravityRoute,
  isRoutePaused,
  loadPausedRoutes,
} from "../../../../fork/pausedRoutes/pausedRoutes";
import {
  type AgentModel,
  setHarnessModels,
} from "../../../../features/sessions/model/models";
import { AcpClient } from "../../core/acp";
import {
  killChild,
  resolveAntigravityBinary,
  spawnChild,
  unwatchChild,
  watchChild,
} from "../../core/child";
import {
  antigravitySpawnCwd,
  modelsFromSessionNew,
} from "./antigravityProtocol";

const PROBE_ID = "monocode-antigravity-probe";
const REQUEST_TIMEOUT_MS = 12_000;
let inflight: Promise<void> | null = null;

export function refreshAntigravityCatalog(): Promise<void> {
  if (inflight) return inflight;
  // Read the pause list even when the probe fails, so the seed default skips paused routes.
  const pausedLoad = loadPausedRoutes();
  inflight = discoverAntigravityModels()
    .then(async (models) => {
      const paused = await pausedLoad;
      if (models.length === 0) return;
      const suffix = " (paused)";
      const annotated = models.map((model) =>
        annotatePausedModel(model, paused, suffix),
      );
      setHarnessModels("antigravity", annotated);
    })
    .catch(async (error: unknown) => {
      // Preserve the last live catalog (or startup seeds) when offline/logged out.
      console.debug("[monocode] antigravity catalog", error);
      await pausedLoad;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function annotatePausedModel(
  model: AgentModel,
  paused: Record<string, string>,
  suffix: string,
): AgentModel {
  const nativeId = model.nativeId;
  if (!nativeId) return model;
  const route = antigravityRoute(nativeId);
  if (!isRoutePaused(route, paused)) return model;
  if (model.name.endsWith(suffix)) return model;
  return { ...model, name: `${model.name}${suffix}` };
}

export async function discoverAntigravityModels(workingDirectory?: string) {
  const { path, args } = await resolveAntigravityBinary();
  const cwd = workingDirectory ?? (await homeDir());
  const probeId = `${PROBE_ID}-${crypto.randomUUID()}`;
  const acp = new AcpClient(probeId, {
    onRequest: (id, method) => {
      const response =
        method === "session/request_permission"
          ? acp.respond(id, { outcome: { outcome: "cancelled" } })
          : acp.respondError(id, {
              code: -32601,
              message: `Method not found: ${method}`,
            });
      void response.catch(() => undefined);
    },
  });
  watchChild(
    probeId,
    (line) => acp.pushLine(line),
    () => acp.close(new Error("Antigravity probe exited")),
  );
  try {
    await spawnChild(
      probeId,
      path,
      args,
      antigravitySpawnCwd(path, cwd),
      undefined,
      "antigravity",
    );
    await acp.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          // Without this claim a compliant agent may omit configOptions from
          // session/new, leaving the catalog with nothing to enumerate.
          session: { configOptions: { boolean: {} } },
        },
        clientInfo: { name: "monocode", version: "0.1.0" },
      },
      REQUEST_TIMEOUT_MS,
    );
    // Authentication stays in the provider's Terminal UI; never start OAuth here.
    const created = await acp.request(
      "session/new",
      { cwd, mcpServers: [] },
      REQUEST_TIMEOUT_MS,
    );
    return modelsFromSessionNew(created);
  } finally {
    acp.close();
    unwatchChild(probeId);
    await killChild(probeId).catch(() => undefined);
  }
}
