import { useState, useSyncExternalStore, type ComponentProps } from "react";
import { ExternalSessionViewer } from "../externalSessions/ExternalSessionViewer";
import {
  lookupSessionRef,
  openOwnSession,
  ownSessionFor,
  refKey,
  refTarget,
  subscribeSessionRefs,
} from "./sessionRefs";

function SessionRefLink({ word }: { word: string }) {
  const key = useSyncExternalStore(
    subscribeSessionRefs,
    () => refKey(lookupSessionRef(word)),
    () => "",
  );
  const [viewing, setViewing] = useState(false);
  const ref = key ? lookupSessionRef(word) : undefined;
  if (!ref) {
    return <>{word}</>;
  }
  const open = async () => {
    const own = ref.machineId ? undefined : await ownSessionFor(ref.session);
    if (own) {
      await openOwnSession(own);
    } else {
      setViewing(true);
    }
  };
  return (
    <>
      <button
        type="button"
        data-fork-session-ref={word}
        title={`Open session ${ref.session.name ?? word}`}
        onClick={() => void open().catch(() => setViewing(true))}
        className="cursor-pointer text-sky-400/90 outline-none hover:text-sky-300 hover:underline focus-visible:underline"
      >
        {word}
      </button>
      {viewing ? (
        <ExternalSessionViewer
          target={refTarget(ref)}
          session={ref.session}
          cwd={ref.machineId ? undefined : ref.session.projectId}
          onClose={() => setViewing(false)}
        />
      ) : null}
    </>
  );
}

/** A Markdown span: a marked session mention, or any other span untouched. */
export function MarkdownSpan({
  node: _node,
  ...props
}: ComponentProps<"span"> & { node?: unknown; "data-session-ref"?: string }) {
  const word = props["data-session-ref"];
  return word ? <SessionRefLink word={word} /> : <span {...props} />;
}
