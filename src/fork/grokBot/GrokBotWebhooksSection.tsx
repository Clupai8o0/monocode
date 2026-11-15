import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Loader } from "../../shared/ui/icons";
import type { GrokBotBot } from "./agentGrokBot";
import {
  SETUP_PROMPT,
  hookLine,
  loadBots,
  loadWebhooks,
  removeWebhook,
  saveWebhook,
  webhookRows,
  type WebhookRow,
} from "./grokBotWebhooks";

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

/** One row's form. Its own state, so a URL or key typed for one bot never shows in another's. */
function WebhookForm({
  botId,
  saving,
  onSave,
  onCancel,
}: {
  botId: string;
  saving: boolean;
  onSave: (botId: string, url: string, key: string) => void;
  onCancel: () => void;
}) {
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const saveReady = url.trim().length > 0 && key.trim().length > 0 && !saving;

  return (
    <form
      className="mt-3 flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!saveReady) return;
        onSave(botId, url.trim(), key.trim());
      }}
    >
      <input
        type="url"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder="https://…"
        autoComplete="off"
        className="h-8 rounded-lg bg-content/[0.06] px-2.5 text-[13px] text-content outline-none placeholder:text-content/30 focus-visible:outline-2 focus-visible:outline-accent"
      />
      <input
        type="password"
        value={key}
        onChange={(event) => setKey(event.target.value)}
        placeholder="Key or Authorization header"
        autoComplete="off"
        className="h-8 rounded-lg bg-content/[0.06] px-2.5 text-[13px] text-content outline-none placeholder:text-content/30 focus-visible:outline-2 focus-visible:outline-accent"
      />
      <div className="flex items-center gap-1.5">
        <button
          type="submit"
          disabled={!saveReady}
          className={`inline-flex h-7 items-center gap-1.5 rounded-lg bg-content px-2.5 text-[12px] font-medium text-background-base hover:bg-content/85 ${PRESS}`}
        >
          {saving ? (
            <Loader className="size-3.5 animate-spin" aria-hidden />
          ) : null}
          Save
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={onCancel}
          className={`h-7 rounded-lg px-2.5 text-[12px] text-content/60 hover:bg-content/8 hover:text-content ${PRESS}`}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export function GrokBotWebhooksView({
  rows,
  loading,
  loadError,
  rowError,
  rowErrorBotId,
  saving,
  addingBotId,
  confirmRemoveId,
  now,
  onAddStart,
  onAddCancel,
  onSave,
  onRemoveConfirm,
  onRemove,
  onRowTouched,
}: {
  rows: readonly WebhookRow[];
  loading: boolean;
  loadError?: string;
  rowError?: string;
  rowErrorBotId?: string;
  saving: boolean;
  addingBotId: string | null;
  confirmRemoveId: string | null;
  now: number;
  onAddStart: (botId: string) => void;
  onAddCancel: () => void;
  onSave: (botId: string, url: string, key: string) => void;
  onRemoveConfirm: (botId: string) => void;
  onRemove: (botId: string) => void;
  onRowTouched: (botId: string) => void;
}) {
  return (
    <section
      data-setting-id="grok-bot-webhooks"
      id="setting-grok-bot-webhooks"
      className="mt-10 flex flex-col gap-4 font-sans"
    >
      <div>
        <h3 className="text-[14px] font-semibold text-content">
          Let sessions run Grok Bot bots
        </h3>
        <p className="mt-1 max-w-[62ch] text-[12px] leading-relaxed text-content/50">
          Claude sessions can start a bot&apos;s run without you pressing send. Each bot
          needs its own webhook routine, and every run uses your Grok Bot plan.
        </p>
        {loadError ? (
          <p role="alert" className="mt-1 text-[12px] text-red-400">
            {loadError}
          </p>
        ) : null}
      </div>

      <ol className="max-w-[62ch] list-decimal space-y-2 pl-4 text-[12px] leading-relaxed text-content/50">
        <li>
          <span>In Grok Bot, send the bot this message:</span>
          <div className="mt-1.5">
            <div className="mb-1 flex items-center justify-end">
              <CopyButton text={SETUP_PROMPT} label="Copy" />
            </div>
            <pre className="whitespace-pre-wrap break-words rounded-lg bg-content/[0.06] px-2.5 py-2 font-mono text-[11px] leading-relaxed text-content/85">
              {SETUP_PROMPT}
            </pre>
          </div>
        </li>
        <li>Open the new routine in the bot&apos;s Details tab and find Webhook.</li>
        <li>
          Press Add webhook below and paste the &quot;POST to&quot; address and the key.
        </li>
      </ol>

      {loading ? (
        <p className="inline-flex items-center gap-1.5 text-[12px] text-content/50">
          <Loader className="size-3.5 animate-spin" aria-hidden />
          Loading bots…
        </p>
      ) : rows.length === 0 ? (
        <p className="text-[12px] text-content/45">No Grok Bot bots found.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((row) => {
            const isAdding = addingBotId === row.botId;
            const subLine = row.missing
              ? row.botId
              : row.hook
                ? hookLine(row.hook, now)
                : "No webhook";

            return (
              <li
                key={row.botId}
                className="flex flex-col rounded-xl bg-content/[0.04] px-3.5 py-2.5"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium text-content">{row.name}</p>
                    <p className="mt-0.5 text-[12px] text-content/50">{subLine}</p>
                  </div>
                  {row.hook || row.missing ? (
                    confirmRemoveId === row.botId ? (
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => {
                          onRemove(row.botId);
                        }}
                        className={`h-7 shrink-0 rounded-lg px-2.5 text-[12px] font-medium text-amber-500 hover:bg-content/8 ${PRESS}`}
                      >
                        Remove?
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => {
                          onRowTouched(row.botId);
                          onRemoveConfirm(row.botId);
                        }}
                        className={`h-7 shrink-0 rounded-lg px-2.5 text-[12px] text-content/60 hover:bg-content/8 hover:text-content ${PRESS}`}
                      >
                        Remove
                      </button>
                    )
                  ) : (
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => {
                        onRowTouched(row.botId);
                        onAddStart(row.botId);
                      }}
                      className={`h-7 shrink-0 rounded-lg bg-content/10 px-2.5 text-[12px] font-medium text-content hover:bg-content/15 ${PRESS}`}
                    >
                      Add webhook
                    </button>
                  )}
                </div>

                {isAdding ? (
                  <WebhookForm
                    botId={row.botId}
                    saving={saving}
                    onSave={onSave}
                    onCancel={onAddCancel}
                  />
                ) : null}

                {rowError && rowErrorBotId === row.botId ? (
                  <p role="alert" className="mt-1 text-[12px] text-red-400">
                    {rowError}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function message(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/** Fork: Settings > Grok Bot webhooks for session-started runs. */
export function GrokBotWebhooksSection() {
  const [bots, setBots] = useState<GrokBotBot[]>([]);
  const [hooks, setHooks] = useState<Awaited<ReturnType<typeof loadWebhooks>>>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [rowError, setRowError] = useState<string>();
  const [rowErrorBotId, setRowErrorBotId] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [addingBotId, setAddingBotId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);

  const reloadHooks = useCallback(() => {
    return loadWebhooks()
      .then((next) => setHooks(Array.isArray(next) ? next : []))
      .catch((failure) => setLoadError(message(failure)));
  }, []);

  const refresh = useCallback(() => {
    setNow(Date.now());
    const botsPromise = loadBots()
      .then((roster) => {
        setBots(Array.isArray(roster?.bots) ? roster.bots : []);
      })
      .catch((failure) => {
        setLoadError(message(failure));
        setBots([]);
      });
    const hooksPromise = loadWebhooks()
      .then((next) => setHooks(Array.isArray(next) ? next : []))
      .catch((failure) => setLoadError((current) => current ?? message(failure)));
    return Promise.all([botsPromise, hooksPromise]).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (confirmRemoveId === null) return;
    const timer = window.setTimeout(() => setConfirmRemoveId(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [confirmRemoveId]);

  const rows = webhookRows(bots, hooks);

  return (
    <GrokBotWebhooksView
      rows={rows}
      loading={loading}
      loadError={loadError}
      rowError={rowError}
      rowErrorBotId={rowErrorBotId}
      saving={saving}
      addingBotId={addingBotId}
      confirmRemoveId={confirmRemoveId}
      now={now}
      onAddStart={(botId) => {
        setRowError(undefined);
        setRowErrorBotId(undefined);
        setConfirmRemoveId(null);
        setAddingBotId(botId);
      }}
      onAddCancel={() => {
        setAddingBotId(null);
      }}
      onSave={(botId, url, key) => {
        setSaving(true);
        setRowError(undefined);
        setRowErrorBotId(undefined);
        saveWebhook(botId, url, key)
          .then(() => {
            setAddingBotId((current) => (current === botId ? null : current));
            return reloadHooks();
          })
          .catch((failure) => {
            setRowErrorBotId(botId);
            setRowError(message(failure));
          })
          .finally(() => setSaving(false));
      }}
      onRemoveConfirm={(botId) => {
        setRowError(undefined);
        setRowErrorBotId(undefined);
        setAddingBotId(null);
        setConfirmRemoveId(botId);
      }}
      onRemove={(botId) => {
        setConfirmRemoveId(null);
        setRowError(undefined);
        setRowErrorBotId(undefined);
        removeWebhook(botId)
          .then(() => reloadHooks())
          .catch((failure) => {
            setRowErrorBotId(botId);
            setRowError(message(failure));
          });
      }}
      onRowTouched={(botId) => {
        if (confirmRemoveId !== null && confirmRemoveId !== botId) {
          setConfirmRemoveId(null);
        }
      }}
    />
  );
}
