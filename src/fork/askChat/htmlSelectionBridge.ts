import { useEffect, useRef, useState, type RefObject } from "react";
import type { TranscriptSelection } from "../../features/sessions/model/transcriptSelection";
import { quoteForChat } from "./askChatModel";
import { focusAskChatButton } from "./AskChatRegion";
import { ASK_CHAT_ENABLED } from "./useAskChatSelection";

const MESSAGE = "monocode:html-selection";
/** The page is untrusted: never take more of its text than a person would. */
const MAX_TEXT = 200_000;

/**
 * Runs in the previewed page, which has an opaque origin the app cannot read
 * (on purpose, see `HtmlPreview`). One-way: it posts the selection to the app
 * and never listens to it, so the sandbox gains nothing.
 */
const BRIDGE = `(function(){
var me=document.currentScript;if(me)me.remove();
var down=false,frame=0;
function post(text,rect,tab){parent.postMessage({type:${JSON.stringify(MESSAGE)},text:text,rect:rect,tab:tab},"*");}
function report(){
frame=0;
var s=getSelection(),text=s&&!s.isCollapsed?s.toString():"",rect=null;
if(text.trim()&&s.rangeCount){
var r=s.getRangeAt(0),list=r.getClientRects(),b=null;
for(var i=0;i<list.length&&!b;i++){if(list[i].width>0||list[i].height>0){b=list[i];}}
b=b||r.getBoundingClientRect();
rect=[b.left,b.top,b.width,b.height];
}
post(rect?text:"",rect,false);
}
function schedule(){cancelAnimationFrame(frame);frame=requestAnimationFrame(report);}
addEventListener("pointerdown",function(){down=true;cancelAnimationFrame(frame);},true);
addEventListener("pointerup",function(){down=false;schedule();},true);
addEventListener("pointercancel",function(){down=false;},true);
document.addEventListener("selectionchange",function(){if(!down){schedule();}});
addEventListener("scroll",function(){post("",null,false);},true);
addEventListener("keydown",function(e){
if(e.key==="Escape"){var c=getSelection();if(c&&!c.isCollapsed){c.removeAllRanges();}return;}
if(e.key!=="Tab"||e.shiftKey||e.altKey||e.ctrlKey||e.metaKey){return;}
var s=getSelection(),t=e.target;
if(!s||s.isCollapsed||!s.toString().trim()){return;}
if(t&&(t.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))){return;}
post("",null,true);
},true);
})();`;

/** Appended to the page's source, not its file: the file on disk is untouched. */
export function withSelectionBridge(source: string): string {
  return `${source}\n<script>${BRIDGE}</script>`;
}

export type FrameMessage =
  | { kind: "clear" }
  | { kind: "tab" }
  | { kind: "selection"; text: string; rect: DOMRect };

type FrameBox = { left: number; top: number; right: number; bottom: number };

/** Checks a message from the page, and keeps its rect inside the frame. */
export function parseFrameMessage(
  data: unknown,
  frame: FrameBox,
): FrameMessage | null {
  if (!data || typeof data !== "object") return null;
  const { type, text, rect, tab } = data as Record<string, unknown>;
  if (type !== MESSAGE) return null;
  if (tab === true) return { kind: "tab" };
  if (
    typeof text !== "string" ||
    !text.trim() ||
    !Array.isArray(rect) ||
    rect.length !== 4 ||
    !rect.every((value) => typeof value === "number" && Number.isFinite(value))
  ) {
    return { kind: "clear" };
  }
  const [left, top, width, height] = rect as number[];
  const x = Math.min(Math.max(frame.left + left, frame.left), frame.right);
  const y = Math.min(Math.max(frame.top + top, frame.top), frame.bottom);
  return {
    kind: "selection",
    text: text.slice(0, MAX_TEXT),
    rect: new DOMRect(
      x,
      y,
      Math.min(Math.max(width, 0), frame.right - x),
      Math.min(Math.max(height, 0), frame.bottom - y),
    ),
  };
}

/** Selection inside a previewed HTML page, reported by its bridge. */
export function useFrameSelection(
  frameRef: RefObject<HTMLIFrameElement | null>,
  reference: string,
  pageId: string | null,
): {
  selection: TranscriptSelection | null;
  dismissSelection: () => void;
} {
  const [selection, setSelection] = useState<TranscriptSelection | null>(null);
  const referenceRef = useRef(reference);
  referenceRef.current = reference;

  useEffect(() => {
    setSelection(null);
    if (!ASK_CHAT_ENABLED || !pageId) return;
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      // Only this frame's own window: the sandbox gives it the origin "null".
      if (!frame || event.source !== frame.contentWindow) return;
      const message = parseFrameMessage(
        event.data,
        frame.getBoundingClientRect(),
      );
      if (!message) return;
      if (message.kind === "tab") {
        // Tab has already moved on inside the page by the time this arrives.
        focusAskChatButton(frame);
      } else if (message.kind === "clear") {
        setSelection(null);
      } else {
        setSelection({
          text: quoteForChat(referenceRef.current, message.text),
          rect: message.rect,
        });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frameRef, pageId]);

  return { selection, dismissSelection: () => setSelection(null) };
}
