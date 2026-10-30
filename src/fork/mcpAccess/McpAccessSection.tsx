import { useCallback, useEffect, useState } from "react";
import type { RecentProject } from "../../features/projects/model/recents";
import { prettyCwd, projectName } from "../../shared/lib/paths";
import { Check, CircleX, Copy, Loader } from "../../shared/ui/icons";
import {
  createMcpClient,
  loadMcpClients,
  loadMcpLog,
  MCP_LEVELS,
  mcpActionText,
  mcpConfig,
  revokeMcpClient,
  type CreatedMcpClient,
  type McpClient,
  type McpLevel,
  type McpLogEntry,
} from "./mcpAccess";

const PRESS =
  "transition-[background-color,color,transform] duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => setCopied(true));
      }}
      className={`inline-flex h-6 items-center gap-1 rounded-md bg-content/10 px-1.5 text-[11px] text-content hover:bg-content/15 ${PRESS}`}
    >
      {copied ? (
        <Check className="size-3" aria-hidden />
      ) : (
        <Copy className="size-3" aria-hidden />
      )}
      {copied ? "Copied" : label}
    </button>
  );
}

/** Shown once after creating a client, as the token can't be read back. */
export function CreatedClientCard({
  created,
  onDone,
}: {
  created: CreatedMcpClient;
  onDone: () => void;
}) {
  const config = mcpConfig(created);
  return (
    <div
      data-fork-mcp-created
      className="flex flex-col gap-2.5 rounded-xl bg-accent/[0.08] px-3.5 py-3"
    >
      <div>
        <p className="text-[13px] font-medium text-content">
          Add this to {created.client.name}&apos;s config
        </p>
        <p className="mt-0.5 text-[12px] text-content/55">
          It holds the client&apos;s token, which won&apos;t be shown again. Keep
          it out of anything you share. MonoCode has to be running for calls to work.
        </p>
      </div>
      {(
        [
          ["Claude, dsh, grok and most agents (JSON)", config.json],
          ["Codex (~/.codex/config.toml)", config.toml],
        ] as const
      ).map(([label, text]) => (
        <div key={label}>
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[11px] text-content/55">{label}</span>
            <CopyButton text={text} label="Copy" />
          </div>
          <pre className="max-h-40 overflow-auto rounded-lg bg-content/[0.06] px-2.5 py-2 font-mono text-[11px] leading-relaxed text-content/85">
            {text}
          </pre>
        </div>
      ))}
      <button
        type="button"
        onClick={onDone}
        className={`h-7 w-fit rounded-lg bg-content/10 px-2.5 text-[12px] font-medium text-content hover:bg-content/15 ${PRESS}`}
      >
        Done
      </button>
    </div>
  );
}

function timeAgo(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function McpAccessView({
  projects,
  clients,
  log,
  created,
  busy,
  error,
  now,
  onCreate,
  onRevoke,
  onDoneWithCreated,
}: {
  projects: readonly string[];
  clients: readonly McpClient[];
  log: readonly McpLogEntry[];
  created: CreatedMcpClient | null;
  busy: boolean;
  error?: string;
  now: number;
  onCreate: (name: string, level: McpLevel, projects: string[]) => void;
  onRevoke: (id: string) => void;
  onDoneWithCreated: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  // The safest level first: more is a deliberate choice.
  const [level, setLevel] = useState<McpLevel>("read");
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const toggle = (project: string) =>
    setChosen((current) =>
      current.includes(project)
        ? current.filter((entry) => entry !== project)
        : [...current, project],
    );
  const ready = name.trim().length > 0 && chosen.length > 0 && !busy;

  return (
    <section
      data-setting-id="mcp-access"
      id="setting-mcp-access"
      className="mt-10 flex flex-col gap-4 font-sans"
    >
      <div>
        <h3 className="text-[14px] font-semibold text-content">
          Let outside agents use MonoCode
        </h3>
        <p className="mt-1 max-w-[62ch] text-[12px] leading-relaxed text-content/50">
          Codex, dsh, grok and others can reach your sessions over MCP. Nothing
          can connect until you add it here. Each one has its own token, level and
          projects, and none of them can delete or archive.
        </p>
      </div>

      {created ? (
        <CreatedClientCard created={created} onDone={onDoneWithCreated} />
      ) : null}

      {clients.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {clients.map((client) => (
            <li
              key={client.id}
              className="flex min-w-0 items-center gap-3 rounded-xl bg-content/[0.04] px-3.5 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-content">
                  {client.name}
                  <span
                    className={`ml-2 text-[11px] font-normal ${
                      client.level === "full" ? "text-amber-500" : "text-content/50"
                    }`}
                  >
                    {MCP_LEVELS.find((entry) => entry.id === client.level)?.label}
                  </span>
                </p>
                <p
                  className="mt-0.5 truncate text-[11px] text-content/50"
                  title={client.projects.map(prettyCwd).join("\n")}
                >
                  {client.projects.map(projectName).join(", ")}
                </p>
              </div>
              {confirmRevoke === client.id ? (
                <button
                  type="button"
                  onClick={() => {
                    setConfirmRevoke(null);
                    onRevoke(client.id);
                  }}
                  className={`h-7 shrink-0 rounded-lg bg-diff-del-fg/15 px-2.5 text-[12px] font-medium text-diff-del-fg hover:bg-diff-del-fg/25 ${PRESS}`}
                >
                  Confirm remove
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmRevoke(client.id)}
                  className={`h-7 shrink-0 rounded-lg px-2.5 text-[12px] text-content/60 hover:bg-content/8 hover:text-content ${PRESS}`}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {adding ? (
        <form
          className="flex flex-col gap-3 rounded-xl bg-content/[0.04] px-3.5 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready) return;
            onCreate(name.trim(), level, [...chosen]);
            setAdding(false);
            setName("");
            setChosen([]);
            setLevel("read");
          }}
        >
          <label className="flex flex-col gap-1 text-[12px] text-content/60">
            Name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Codex on the Mac"
              maxLength={64}
              autoFocus
              className="h-8 rounded-lg bg-content/[0.06] px-2.5 text-[13px] text-content outline-none placeholder:text-content/30 focus-visible:outline-2 focus-visible:outline-accent"
            />
          </label>
          <div
            role="radiogroup"
            aria-label="What it can do"
            className="grid grid-cols-1 gap-1 @min-[560px]/settings:grid-cols-3"
          >
            {MCP_LEVELS.map((choice) => (
              <button
                key={choice.id}
                type="button"
                role="radio"
                aria-checked={level === choice.id}
                onClick={() => setLevel(choice.id)}
                className={`rounded-lg px-2.5 py-2 text-left ${PRESS} ${
                  level === choice.id
                    ? "bg-accent/12"
                    : "bg-content/[0.04] hover:bg-content/[0.07]"
                }`}
              >
                <span className="block text-[12px] font-medium text-content">
                  {choice.label}
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-content/50">
                  {choice.note}
                </span>
              </button>
            ))}
          </div>
          <div>
            <p className="mb-1 text-[12px] text-content/60">Projects it can use</p>
            {projects.length === 0 ? (
              <p className="text-[12px] text-content/45">Open a project first.</p>
            ) : (
              <div className="flex flex-wrap gap-1">
                {projects.map((project) => {
                  const on = chosen.includes(project);
                  return (
                    <button
                      key={project}
                      type="button"
                      aria-pressed={on}
                      title={prettyCwd(project)}
                      onClick={() => toggle(project)}
                      className={`inline-flex h-6 items-center gap-1 rounded-md px-2 text-[12px] ${PRESS} ${
                        on
                          ? "bg-accent/15 font-medium text-content"
                          : "bg-content/[0.06] text-content/65 hover:text-content"
                      }`}
                    >
                      {on ? <Check className="size-3" aria-hidden /> : null}
                      {projectName(project)}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="submit"
              disabled={!ready}
              className={`inline-flex h-7 items-center gap-1.5 rounded-lg bg-content px-2.5 text-[12px] font-medium text-background-base hover:bg-content/85 ${PRESS}`}
            >
              {busy ? <Loader className="size-3.5 animate-spin" aria-hidden /> : null}
              Create token
            </button>
            <button
              type="button"
              onClick={() => setAdding(false)}
              className={`h-7 rounded-lg px-2.5 text-[12px] text-content/60 hover:bg-content/8 hover:text-content ${PRESS}`}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className={`h-7 w-fit rounded-lg bg-content/10 px-2.5 text-[12px] font-medium text-content hover:bg-content/15 ${PRESS}`}
        >
          Add an agent
        </button>
      )}

      {error ? (
        <p role="alert" className="text-[12px] text-diff-del-fg">
          {error}
        </p>
      ) : null}

      <div>
        <h4 className="text-[13px] font-medium text-content">Who did what</h4>
        {log.length === 0 ? (
          <p className="mt-1 text-[12px] text-content/45">
            Nothing yet. Every call lands here, without its prompt.
          </p>
        ) : (
          <ol className="mt-1.5 flex max-h-72 flex-col gap-1 overflow-y-auto">
            {log.map((entry, index) => (
              <li
                key={`${entry.at}-${index}`}
                className="flex min-w-0 items-baseline gap-2 text-[12px]"
              >
                <span className="w-14 shrink-0 text-[11px] tabular-nums text-content/40">
                  {timeAgo(entry.at, now)}
                </span>
                {entry.ok ? (
                  <Check className="size-3 shrink-0 self-center text-diff-add-fg" aria-label="Done" />
                ) : (
                  <CircleX className="size-3 shrink-0 self-center text-diff-del-fg" aria-label="Refused" />
                )}
                <span className="min-w-0 flex-1 truncate text-content/70" title={entry.error ?? entry.target ?? undefined}>
                  <span className="font-medium text-content">{entry.client}</span>{" "}
                  {mcpActionText(entry.action)}
                  {entry.target ? (
                    <span className="text-content/45"> {projectName(entry.target)}</span>
                  ) : null}
                  {entry.error ? (
                    <span className="text-diff-del-fg"> {entry.error}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

/** Fork: Settings > MCP, under the servers MonoCode itself uses. */
export function McpAccessSection({ recents = [] }: { recents?: readonly RecentProject[] }) {
  const [clients, setClients] = useState<McpClient[]>([]);
  const [log, setLog] = useState<McpLogEntry[]>([]);
  const [created, setCreated] = useState<CreatedMcpClient | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(Date.now);

  const refresh = useCallback(() => {
    setNow(Date.now());
    loadMcpClients()
      .then((next) => setClients(next ?? []))
      .catch((failure) => setError(String(failure)));
    loadMcpLog()
      .then((next) => setLog(next ?? []))
      .catch((failure) => setError(String(failure)));
  }, []);
  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return (
    <McpAccessView
      projects={recents.map((entry) => entry.path).filter((path) => path !== "~")}
      clients={clients}
      log={log}
      created={created}
      busy={busy}
      error={error}
      now={now}
      onCreate={(name, level, projects) => {
        setBusy(true);
        setError(undefined);
        createMcpClient(name, level, projects)
          .then((next) => {
            setCreated(next);
            refresh();
          })
          .catch((failure) => setError(String(failure)))
          .finally(() => setBusy(false));
      }}
      onRevoke={(id) => {
        setError(undefined);
        revokeMcpClient(id).then(refresh).catch((failure) => setError(String(failure)));
      }}
      onDoneWithCreated={() => setCreated(null)}
    />
  );
}
