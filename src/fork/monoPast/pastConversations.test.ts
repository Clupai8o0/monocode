// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { pastConversations, rememberPastConversation } from "./pastConversations";

beforeEach(() => localStorage.clear());

it("lists a Mono's set-aside chats newest first, without duplicates or other Monos' chats", () => {
  rememberPastConversation("a", { id: "1", title: "First", at: 1 });
  rememberPastConversation("a", { id: "2", title: "Second", at: 2 });
  rememberPastConversation("b", { id: "3", title: "Other", at: 3 });
  rememberPastConversation("a", { id: "1", title: "First again", at: 4 });
  expect(pastConversations("a").map((past) => past.title)).toEqual(["First again", "Second"]);
  expect(pastConversations("b")).toHaveLength(1);
  expect(pastConversations("none")).toEqual([]);
});

it("keeps the newest fifty and survives a broken saved copy", () => {
  for (let at = 0; at < 60; at += 1) {
    rememberPastConversation("a", { id: `${at}`, title: "Chat", at });
  }
  expect(pastConversations("a")).toHaveLength(50);
  expect(pastConversations("a")[0]?.id).toBe("59");
  localStorage.setItem("monocode.fork.monoPastConversations", "not json");
  expect(pastConversations("a")).toEqual([]);
});
