import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type {
  CompletionContext,
  CompletionResult,
} from "@codemirror/autocomplete";
import type { Compartment, Extension } from "@codemirror/state";
import type { Diagnostic } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import { useColorScheme } from "../../../shared/hooks/useColorScheme";
import {
  completionWords,
  drillPath,
  finishPythonSource,
  indentFor,
} from "./codeEditorModel";
import { nameWarnings } from "./codeNames";
import type { DrillLanguage } from "./codeModel";

/**
 * Fork: the Code tab's editor. CodeMirror is imported only when this component
 * mounts, so the Games panel stays light until the Code tab is actually opened.
 * The app's own file editor is untouched; this borrows its extensions.
 */

type SyntaxNodeLike = {
  name: string;
  from: number;
  to: number;
  parent: SyntaxNodeLike | null;
};

export type CodeEditorHandle = {
  format: () => Promise<void>;
  focus: () => void;
  goToLine: (line: number) => void;
  markErrorLine: (line: number | null) => void;
  clearErrorLine: () => void;
};

type Props = {
  drillId: string;
  language: DrillLanguage;
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  onSyntaxErrors?: (count: number) => void;
  onNameWarnings?: (count: number) => void;
  testNames?: readonly string[];
};

export const CodeEditor = forwardRef<CodeEditorHandle, Props>(function CodeEditor(
  {
    drillId,
    language,
    value,
    onChange,
    onRun,
    onSyntaxErrors,
    onNameWarnings,
    testNames,
  },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const schemeCompartment = useRef<Compartment | null>(null);
  const drillThemeRef = useRef<Extension | null>(null);
  const formatRef = useRef<(() => Promise<void>) | null>(null);
  const goToLineRef = useRef<((line: number) => void) | null>(null);
  const setErrorLineRef = useRef<((line: number | null) => void) | null>(null);
  const restoreFocus = useRef(false);
  const [ready, setReady] = useState(false);
  const scheme = useColorScheme();

  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;
  const onSyntaxErrorsRef = useRef(onSyntaxErrors);
  onSyntaxErrorsRef.current = onSyntaxErrors;
  const onNameWarningsRef = useRef(onNameWarnings);
  onNameWarningsRef.current = onNameWarnings;
  const testNamesRef = useRef(testNames);
  testNamesRef.current = testNames;
  const schemeRef = useRef(scheme);
  schemeRef.current = scheme;

  useImperativeHandle(
    ref,
    () => ({
      format: () => formatRef.current?.() ?? Promise.resolve(),
      focus: () => viewRef.current?.focus(),
      goToLine: (line) => goToLineRef.current?.(line),
      markErrorLine: (line) => setErrorLineRef.current?.(line),
      clearErrorLine: () => setErrorLineRef.current?.(null),
    }),
    [],
  );

  // A new drill gets a fresh view: its own document, undo history and language.
  useEffect(() => {
    const element = host.current;
    if (!element) {
      return;
    }
    let disposed = false;
    const refocus = restoreFocus.current;
    restoreFocus.current = false;
    setReady(false);

    void (async () => {
      const [
        {
          Decoration,
          EditorView,
          keymap,
          lineNumbers,
          highlightActiveLine,
          highlightActiveLineGutter,
        },
        { Compartment, EditorState, Prec, StateEffect, StateField },
        { indentWithTab },
        { minimalSetup },
        { ensureSyntaxTree, indentRange, indentUnit, syntaxTree },
        { languageForPath, schemeExtensions },
        { editorMatching, editorTyping },
        { editorAutocomplete },
        { editorLint },
        { formatText },
        { completionStatus },
        { forEachDiagnostic, linter },
      ] = await Promise.all([
        import("@codemirror/view"),
        import("@codemirror/state"),
        import("@codemirror/commands"),
        import("codemirror"),
        import("@codemirror/language"),
        import("../../../features/files/editor/editorChrome"),
        import("../../../features/files/editor/editorEditing"),
        import("../../../features/files/editor/editorAutocomplete"),
        import("../../../features/files/editor/editorLint"),
        import("../../../shared/lib/format"),
        import("@codemirror/autocomplete"),
        import("@codemirror/lint"),
      ]);
      if (disposed) {
        return;
      }
      const languageExtension = await languageForPath(drillPath(language));
      if (disposed) {
        return;
      }

      const themeCompartment = new Compartment();
      schemeCompartment.current = themeCompartment;

      // The line a run's error points at stays marked with a red underline
      // until the next edit (any doc change) or the next run clears it.
      const setErrorLineEffect = StateEffect.define<number | null>();
      const errorLineField = StateField.define<number | null>({
        create: () => null,
        update(value, transaction) {
          for (const effect of transaction.effects) {
            if (effect.is(setErrorLineEffect)) {
              return effect.value;
            }
          }
          return transaction.docChanged ? null : value;
        },
      });
      const errorLineDecorations = EditorView.decorations.compute(
        [errorLineField],
        (state) => {
          const lineNumber = state.field(errorLineField);
          if (lineNumber === null) {
            return Decoration.none;
          }
          const line = state.doc.line(
            Math.min(Math.max(1, lineNumber), state.doc.lines),
          );
          // An empty line has nothing to underline, and an empty mark throws.
          if (line.from === line.to) {
            return Decoration.none;
          }
          return Decoration.set([
            Decoration.mark({ class: "cm-drill-error-line" }).range(
              line.from,
              line.to,
            ),
          ]);
        },
      );

      const completionSource = (
        context: CompletionContext,
      ): CompletionResult | null => {
        const word = context.matchBefore(/[A-Za-z_$][\w$]*/);
        if (!word) {
          return null;
        }
        if (word.from === word.to && !context.explicit) {
          return null;
        }
        return {
          from: word.from,
          options: completionWords(
            language,
            context.state.doc.toString(),
          ).map((label) => ({ label, type: "keyword" })),
        };
      };

      const drillTheme = EditorView.theme({
        "&": {
          fontSize: "12px",
          height: "100%",
        },
        ".cm-scroller": {
          overflow: "auto",
        },
        ".cm-content": {
          minHeight: "100%",
          padding: "8px 0 12px",
        },
        ".cm-line": {
          padding: "0 10px 0 6px",
        },
        // The app editor separates its gutter with a rule; the games panel
        // does not use divider lines anywhere, so the numbers sit in space.
        ".cm-gutters": {
          borderRight: "none",
          paddingLeft: "2px",
        },
        ".cm-lineNumbers .cm-gutterElement": {
          minWidth: "28px",
          padding: "0 6px 0 4px",
        },
        ".cm-drill-error-line": {
          textDecoration: "underline",
          textDecorationColor: "#ef4444",
          textDecorationThickness: "1.5px",
          textUnderlineOffset: "3px",
        },
        ".cm-lintRange-warning": {
          backgroundImage: "none",
          textDecoration: "underline wavy #f59e0b",
          textDecorationSkipInk: "none",
          textUnderlineOffset: "3px",
        },
        ".cm-lintPoint-warning:after": {
          borderBottomColor: "#f59e0b",
        },
        ".cm-tooltip-lint .cm-diagnostic-warning": {
          borderLeft: "none",
        },
      });
      drillThemeRef.current = drillTheme;

      const completionData = EditorState.languageData.of(() => [
        { autocomplete: completionSource },
      ]);

      // A second linter beside the syntax one: names read but never bound.
      // It reads testNames through a ref so a drill's tests can change
      // without rebuilding the view.
      const nameLint = linter(
        (view) => {
          const doc = view.state.doc.toString();
          const tree =
            ensureSyntaxTree(view.state, view.state.doc.length, 500) ??
            syntaxTree(view.state);
          const diagnostics: Diagnostic[] = [];
          for (const warning of nameWarnings(
            language,
            doc,
            tree,
            testNamesRef.current ?? [],
          )) {
            const diagnostic: Diagnostic = {
              from: warning.from,
              to: warning.to,
              severity: "warning",
              message: warning.message,
            };
            const suggestion = warning.suggestion;
            // The top-of-doc test warning covers a whole line, not the name;
            // only a warning that sits exactly on its name gets the fix.
            if (
              suggestion !== undefined &&
              doc.slice(warning.from, warning.to) === warning.name
            ) {
              diagnostic.actions = [
                {
                  name: `Change to ${suggestion}`,
                  apply: (target, from, to) => {
                    target.dispatch({
                      changes: { from, to, insert: suggestion },
                    });
                  },
                },
              ];
            }
            diagnostics.push(diagnostic);
          }
          return diagnostics;
        },
        {
          delay: 700,
          needsRefresh: (update) =>
            syntaxTree(update.state) !== syntaxTree(update.startState),
        },
      );

      let reportedSyntax = -1;
      let reportedNames = -1;
      const diagnosticReporter = EditorView.updateListener.of((update) => {
        let syntax = 0;
        let names = 0;
        forEachDiagnostic(update.state, (diagnostic) => {
          if (diagnostic.severity === "error") {
            syntax += 1;
          } else if (diagnostic.severity === "warning") {
            names += 1;
          }
        });
        if (syntax !== reportedSyntax) {
          reportedSyntax = syntax;
          onSyntaxErrorsRef.current?.(syntax);
        }
        if (names !== reportedNames) {
          reportedNames = names;
          onNameWarningsRef.current?.(names);
        }
      });

      const view = new EditorView({
        doc: valueRef.current,
        parent: element,
        extensions: [
          // Escape leaves the editor, unless a list of suggestions is up:
          // then it closes that first. First in the list, so it runs before
          // autocomplete's, which swallows Escape while a lookup is pending.
          Prec.highest(
            keymap.of([
              {
                key: "Escape",
                run: (view) => {
                  if (completionStatus(view.state) === "active") {
                    return false;
                  }
                  view.contentDOM.blur();
                  return true;
                },
                preventDefault: true,
              },
            ]),
          ),
          minimalSetup,
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          EditorView.lineWrapping,
          themeCompartment.of([
            ...schemeExtensions(schemeRef.current),
            drillTheme,
          ]),
          languageExtension ?? [],
          indentUnit.of(indentFor(language)),
          completionData,
          editorMatching,
          editorTyping(drillPath(language)),
          editorAutocomplete,
          editorLint(drillPath(language)),
          nameLint,
          diagnosticReporter,
          drillTheme,
          errorLineField,
          errorLineDecorations,
          Prec.high(
            keymap.of([
              {
                key: "Mod-Enter",
                run: () => {
                  onRunRef.current();
                  return true;
                },
                preventDefault: true,
              },
              {
                key: "Shift-Alt-f",
                run: () => {
                  void formatRef.current?.();
                  return true;
                },
                preventDefault: true,
              },
              indentWithTab,
            ]),
          ),
          EditorView.contentAttributes.of({
            "data-table-board": "",
            "data-fork-code-editor": "",
            "aria-label": "Your code",
            spellcheck: "false",
            autocapitalize: "off",
            autocorrect: "off",
            autocomplete: "off",
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
            if (update.docChanged || update.selectionSet) {
              const line = update.state.doc.lineAt(
                update.state.selection.main.head,
              ).number;
              update.view.contentDOM.setAttribute(
                "data-fork-code-cursor-line",
                String(line),
              );
            }
          }),
        ],
      });
      viewRef.current = view;
      view.contentDOM.setAttribute("data-fork-code-cursor-line", "1");

      const setErrorLine = (line: number | null) => {
        if (viewRef.current !== view || view.state.readOnly) {
          return;
        }
        view.dispatch({ effects: setErrorLineEffect.of(line) });
      };
      const goToLine = (lineNumber: number) => {
        if (viewRef.current !== view) {
          return;
        }
        const line = view.state.doc.line(
          Math.min(
            Math.max(1, Math.floor(lineNumber)),
            view.state.doc.lines,
          ),
        );
        view.dispatch({
          selection: { anchor: line.from },
          effects: [
            EditorView.scrollIntoView(line.from, { y: "center" }),
            setErrorLineEffect.of(line.number),
          ],
        });
        view.focus();
      };
      goToLineRef.current = goToLine;
      setErrorLineRef.current = setErrorLine;

      const format = async () => {
        const active = viewRef.current;
        if (!active || active !== view || active.state.readOnly) {
          return;
        }
        const before = active.state.doc.toString();
        const anchor = active.state.selection.main.head;
        let next: string | null = null;
        let cursor = anchor;
        if (language === "javascript") {
          const result = await formatText(drillPath(language), before, anchor);
          if (!result) {
            return;
          }
          next = result.formatted;
          cursor = result.cursorOffset;
        } else {
          const state = active.state;
          const tree =
            ensureSyntaxTree(state, state.doc.length, 500) ?? syntaxTree(state);
          const inside = (pos: number) => {
            for (
              let node: SyntaxNodeLike | null = tree.resolveInner(pos, 1);
              node;
              node = node.parent
            ) {
              if (/String/.test(node.name) && node.from < pos && node.to > pos) {
                return true;
              }
            }
            return false;
          };
          const edges = [];
          for (let number = 1; number <= state.doc.lines; number += 1) {
            const line = state.doc.line(number);
            edges.push({ start: inside(line.from), end: inside(line.to) });
          }
          const reindented = indentRange(state, 0, state.doc.length).apply(
            state.doc,
          );
          next = finishPythonSource(reindented.toString(), edges, before);
          cursor = Math.min(anchor, next.length);
        }
        if (
          viewRef.current !== view ||
          active.state.doc.toString() !== before ||
          next === null ||
          next === before
        ) {
          return;
        }
        active.dispatch({
          changes: { from: 0, to: active.state.doc.length, insert: next },
          selection: { anchor: Math.min(Math.max(0, cursor), next.length) },
        });
      };
      formatRef.current = format;
      setReady(true);
      if (refocus) {
        view.focus();
      }
    })().catch(() => {
      // The read-only copy stays; the rest of the Code tab keeps working.
    });

    return () => {
      disposed = true;
      const view = viewRef.current;
      if (view) {
        restoreFocus.current = view.hasFocus;
        view.destroy();
        viewRef.current = null;
      }
      schemeCompartment.current = null;
      drillThemeRef.current = null;
      formatRef.current = null;
      goToLineRef.current = null;
      setErrorLineRef.current = null;
      onSyntaxErrorsRef.current?.(0);
      onNameWarningsRef.current?.(0);
      setReady(false);
    };
  }, [drillId, language]);

  // Typing calls this with the same text the view already has, so it does
  // nothing. An external change (a reset, or another drill's saved draft)
  // replaces the document in place without touching focus.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) {
      return;
    }
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    const compartment = schemeCompartment.current;
    if (!view || !compartment) {
      return;
    }
    void import("../../../features/files/editor/editorChrome").then(
      ({ schemeExtensions }) => {
        if (viewRef.current !== view) {
          return;
        }
        view.dispatch({
          effects: compartment.reconfigure([
            ...schemeExtensions(schemeRef.current),
            ...(drillThemeRef.current ? [drillThemeRef.current] : []),
          ]),
        });
      },
    );
  }, [scheme]);

  return (
    <div className="relative h-full min-h-44 w-full overflow-hidden rounded bg-content/5">
      {!ready ? (
        <pre
          data-fork-code-editor-pending=""
          aria-label="Your code"
          className="absolute inset-0 overflow-auto p-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-content/70"
        >
          {value}
        </pre>
      ) : null}
      <div ref={host} className="h-full" />
    </div>
  );
});
