// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  newSession,
  type Session,
} from "../../features/sessions/model/session";
import { useAutoHandoff } from "./useAutoHandoff";
import {
  clearComposerDraft,
  setComposerDraft,
} from "../../features/sessions/model/draftCache";

let root: Root;
let host: HTMLDivElement;
const submit = {
  current: vi.fn(
    (
      _id: string,
      _text: string,
      _attachments: never[],
      _options: { intent?: "plan" | "orchestrate" },
    ) => true,
  ),
};
const connected = () => true;

function Harness({ session }: { session: Session }) {
  useAutoHandoff([session], submit, connected);
  return null;
}

function switched(extra: Partial<Session> = {}): Session {
  return {
    ...newSession("codex", "/repo"),
    blocks: [{ id: "u", role: "user", text: "fix the sidebar" }],
    pendingSwitch: {
      from: "claude",
      fromModel: "claude:opus-5-5",
      fromSettings: {},
      autoContinue: "switch-1",
    },
    ...extra,
  };
}

async function render(session: Session) {
  await act(async () => root.render(createElement(Harness, { session })));
  await act(async () => vi.advanceTimersByTime(200));
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  submit.current.mockReset().mockReturnValue(true);
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});

it("continues an idle switch exactly once, including rerenders", async () => {
  const session = switched();
  await render(session);
  await render({ ...session });
  expect(submit.current).toHaveBeenCalledTimes(1);
  expect(submit.current.mock.calls[0][1]).toContain("Continue");
});

it("waits for the outgoing turn to finish", async () => {
  const session = switched({ busy: true });
  await render(session);
  expect(submit.current).not.toHaveBeenCalled();
  await render({ ...session, busy: false });
  expect(submit.current).toHaveBeenCalledTimes(1);
});

it("does not resume after Stop clears the automatic request", async () => {
  const session = switched({ busy: true });
  await render(session);
  await render({
    ...session,
    busy: false,
    pendingSwitch: { ...session.pendingSwitch!, autoContinue: undefined },
  });
  expect(submit.current).not.toHaveBeenCalled();
});

it("lets queued messages, drafts and questions take priority", async () => {
  for (const extra of [
    { queuedMessages: [{ id: "q", text: "new instructions" }] },
    { blocks: [{ id: "draft", role: "user", text: "unsent", draft: true }] },
    { pendingQuestion: {} },
    { ephemeral: true },
    { orchestrationLeadId: "lead" },
  ]) {
    await render(switched(extra as Partial<Session>));
  }
  expect(submit.current).not.toHaveBeenCalled();
});

it("automatically starts the Continue in another model handoff card", async () => {
  await render(
    switched({
      pendingSwitch: undefined,
      handoffCard: {
        from: "claude",
        to: "codex",
        brief: "Left: verify",
        autoContinue: "card-1",
      },
    }),
  );
  expect(submit.current).toHaveBeenCalledTimes(1);
});

it("does not retry a rejected send on every render", async () => {
  submit.current.mockReturnValue(false);
  const session = switched();
  await render(session);
  await render({ ...session });
  expect(submit.current).toHaveBeenCalledTimes(1);
});

it("does not overtake text typed in the composer during the switch", async () => {
  const session = switched();
  await act(async () => root.render(createElement(Harness, { session })));
  setComposerDraft(session.id, "use this instead");
  await act(async () => vi.advanceTimersByTime(200));
  expect(submit.current).not.toHaveBeenCalled();
  clearComposerDraft(session.id);
});

it("preserves plan intent through the automatic continuation", async () => {
  await render(
    switched({
      blocks: [
        { id: "plan-user", role: "user", text: "plan it", intent: "plan" },
      ],
    }),
  );
  expect(submit.current.mock.calls[0][3]).toEqual({ intent: "plan" });
});

it("preserves plan intent when the handoff starts a separate conversation", async () => {
  await render(
    switched({
      pendingSwitch: undefined,
      blocks: [],
      handoffCard: {
        from: "claude",
        to: "codex",
        brief: "Plan only",
        intent: "plan",
        autoContinue: "plan-card",
      },
    }),
  );
  expect(submit.current.mock.calls[0][3]).toEqual({ intent: "plan" });
});

it("cancels a scheduled switch when the user reverts the picker", async () => {
  const session = switched();
  await act(async () => root.render(createElement(Harness, { session })));
  await render({ ...session, pendingSwitch: undefined, harness: "claude" });
  expect(submit.current).not.toHaveBeenCalled();
});

it("does not postpone the continuation on unrelated streaming rerenders", async () => {
  const session = switched();
  for (let i = 0; i < 5; i++) {
    await act(async () =>
      root.render(createElement(Harness, { session: { ...session } })),
    );
    await act(async () => vi.advanceTimersByTime(40));
  }
  expect(submit.current).toHaveBeenCalledTimes(1);
});
