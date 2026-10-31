import { useState, type ReactNode } from "react";
import { copyText } from "../../../platform/tauri/clipboard";
import {
  isInternalFrame,
  rewriteRunPaths,
  type DrillLanguage,
  type RunErrorSummary,
} from "./codeModel";

/**
 * Fork: the Code tab's console. It keeps everything the runner kept, so a
 * failed run can be read in full: the error first, then Node and Python
 * internals dimmed behind the lines that belong to the drill.
 */

const CHIP =
  "h-6 cursor-pointer whitespace-nowrap rounded px-1.5 text-[11px] leading-none";
const CHIP_ON = "bg-content/10 text-content";
const CHIP_OFF = "text-content/50 hover:bg-content/10 hover:text-content";
const LINK =
  "cursor-pointer underline decoration-content/35 underline-offset-2 hover:text-accent hover:decoration-accent";

type ConsoleTab = "output" | "errors";

const REFERENCE = /your code(?::(\d+)|(?=["']?,\s*line\s+(\d+)))/g;

function lineText(
  text: string,
  onGoToLine: (line: number) => void,
): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(REFERENCE)) {
    const index = match.index ?? 0;
    if (index > last) {
      parts.push(text.slice(last, index));
    }
    const line = Number(match[1] ?? match[2]);
    parts.push(
      <button
        key={index}
        type="button"
        tabIndex={-1}
        data-fork-code-goto={line}
        className={LINK}
        onClick={() => onGoToLine(line)}
      >
        {match[0]}
      </button>,
    );
    last = index + match[0].length;
  }
  if (last < text.length) {
    parts.push(text.slice(last));
  }
  return parts;
}

function ConsoleText({
  text,
  language,
  codeLines,
  onGoToLine,
  attribute,
  hidden,
}: {
  text: string;
  language: DrillLanguage;
  codeLines: readonly string[];
  onGoToLine: (line: number) => void;
  attribute: "data-fork-code-output" | "data-fork-code-errors";
  hidden: boolean;
}) {
  return (
    <div
      {...{ [attribute]: "" }}
      hidden={hidden}
      className="overflow-auto overscroll-contain rounded bg-content/5 p-2"
      style={{ maxHeight: "max(240px, 45vh)" }}
    >
      {text.split("\n").map((raw, index) => {
        const line = rewriteRunPaths(raw, language, codeLines);
        return (
          <div
            key={index}
            className={
              isInternalFrame(raw, language)
                ? "font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-content/35"
                : "font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-content/75"
            }
          >
            {line ? lineText(line, onGoToLine) : "\u00a0"}
          </div>
        );
      })}
    </div>
  );
}

function ErrorSummary({
  summary,
  onGoToLine,
}: {
  summary: RunErrorSummary;
  onGoToLine: (line: number) => void;
}) {
  const line = summary.line;
  return (
    <p
      data-fork-code-error-summary=""
      className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono text-[11px] leading-relaxed"
    >
      <span className="font-medium text-content/85">
        {summary.type}
        {summary.message ? `: ${summary.message}` : ""}
      </span>
      {line !== null ? (
        summary.where === "code" ? (
          <button
            type="button"
            tabIndex={-1}
            data-fork-code-goto={line}
            className={LINK}
            onClick={() => onGoToLine(line)}
          >
            {`line ${line}${
              summary.column !== null ? `, col ${summary.column}` : ""
            } in your code`}
          </button>
        ) : (
          <span className="text-content/45">
            line {line}
            {summary.column !== null ? `, col ${summary.column}` : ""} in tests
          </span>
        )
      ) : null}
    </p>
  );
}

export function CodeConsole({
  language,
  stdout,
  stderr,
  truncated,
  codeLines,
  summary,
  openOnErrors,
  onGoToLine,
}: {
  language: DrillLanguage;
  stdout: string;
  stderr: string;
  truncated: boolean;
  codeLines: readonly string[];
  summary: RunErrorSummary | null;
  openOnErrors: boolean;
  onGoToLine: (line: number) => void;
}) {
  const hasOutput = stdout.length > 0 || truncated;
  const hasErrors = stderr.length > 0;
  const [tab, setTab] = useState<ConsoleTab>(() =>
    hasErrors && (!hasOutput || openOnErrors) ? "errors" : "output",
  );
  const [copied, setCopied] = useState(false);
  const active: ConsoleTab =
    tab === "errors" && hasErrors ? "errors" : "output";
  const outputText =
    truncated && stdout
      ? `Earlier output was cut; this is the last 64 KB.\n${stdout}`
      : truncated
        ? "Earlier output was cut; this is the last 64 KB."
        : stdout;

  const copy = () => {
    const parts: string[] = [];
    if (summary) {
      parts.push(
        `${summary.type}${summary.message ? `: ${summary.message}` : ""}${
          summary.line !== null && summary.where === "code"
            ? ` (line ${summary.line}${summary.column !== null ? `, col ${summary.column}` : ""} in your code)`
            : ""
        }`,
      );
    }
    if (hasOutput) {
      parts.push(`Output\n${outputText}`);
    }
    if (hasErrors) {
      parts.push(`Errors\n${stderr}`);
    }
    void copyText(parts.join("\n\n"))
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };

  return (
    <section
      data-fork-code-console=""
      className="flex flex-col gap-1"
      aria-label="Console"
    >
      <div className="flex items-center gap-1">
        <p className="px-0.5 text-[11px] text-content/45">Console</p>
        {hasOutput && hasErrors ? (
          <div className="flex items-center gap-0.5" aria-label="Console view">
            <button
              type="button"
              tabIndex={-1}
              aria-pressed={active === "output"}
              className={`${CHIP} ${active === "output" ? CHIP_ON : CHIP_OFF}`}
              onClick={() => setTab("output")}
            >
              Output
            </button>
            <button
              type="button"
              tabIndex={-1}
              aria-pressed={active === "errors"}
              className={`${CHIP} ${active === "errors" ? CHIP_ON : CHIP_OFF}`}
              onClick={() => setTab("errors")}
            >
              Errors
            </button>
          </div>
        ) : null}
        <button
          type="button"
          tabIndex={-1}
          data-fork-code-copy=""
          className={`${CHIP} ${CHIP_OFF} ml-auto`}
          onClick={copy}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {hasErrors && summary && active === "errors" ? (
        <ErrorSummary summary={summary} onGoToLine={onGoToLine} />
      ) : null}
      {hasOutput ? (
        <ConsoleText
          text={outputText}
          language={language}
          codeLines={codeLines}
          onGoToLine={onGoToLine}
          attribute="data-fork-code-output"
          hidden={active !== "output"}
        />
      ) : null}
      {hasErrors ? (
        <ConsoleText
          text={stderr}
          language={language}
          codeLines={codeLines}
          onGoToLine={onGoToLine}
          attribute="data-fork-code-errors"
          hidden={active !== "errors"}
        />
      ) : null}
    </section>
  );
}
