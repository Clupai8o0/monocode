import { describe, expect, it } from "vitest";
import {
  remoteControlReply,
  remoteControlRequest,
  remoteControlUnavailable,
  trackRemoteControl,
} from "./remoteControl";

function initReply(reply: Record<string, unknown>, subtype = "success") {
  return {
    type: "control_response",
    response: { subtype, request_id: "monocode_1", response: reply },
  };
}

function controlReply(
  requestId: string,
  response: Record<string, unknown>,
) {
  return {
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response },
  };
}

function errorReply(requestId: string, error: string) {
  return {
    type: "control_response",
    response: { subtype: "error", request_id: requestId, error },
  };
}

describe("remoteControlRequest", () => {
  it("asks once per session when Claude's startup setting is on", () => {
    const session = {};
    const rec = initReply({
      remote_control_auto_enable: true,
      remote_control_available: true,
    });
    expect(remoteControlRequest(session, rec)).toEqual({
      subtype: "remote_control",
      enabled: true,
    });
    expect(remoteControlRequest(session, rec)).toBeUndefined();
    expect(remoteControlRequest({}, rec)).toEqual({
      subtype: "remote_control",
      enabled: true,
    });
  });

  it("stays off when the setting is off, unavailable or unknown", () => {
    expect(
      remoteControlRequest({}, initReply({ remote_control_auto_enable: false })),
    ).toBeUndefined();
    expect(
      remoteControlRequest(
        {},
        initReply({
          remote_control_auto_enable: true,
          remote_control_available: false,
        }),
      ),
    ).toBeUndefined();
    // An older Claude leaves the field out.
    expect(remoteControlRequest({}, initReply({ commands: [] }))).toBeUndefined();
    expect(
      remoteControlRequest(
        {},
        initReply({ remote_control_auto_enable: true }, "error"),
      ),
    ).toBeUndefined();
  });

  it("ignores replies that are not Claude's initialize reply", () => {
    expect(
      remoteControlRequest(
        {},
        { type: "control_response", response: { subtype: "success" } },
      ),
    ).toBeUndefined();
    expect(
      remoteControlRequest(
        {},
        {
          type: "control_response",
          response: {
            subtype: "success",
            response: { bridge_session_id: "b1" },
          },
        },
      ),
    ).toBeUndefined();
    expect(remoteControlRequest({}, { type: "control_response" })).toBeUndefined();
  });
});

describe("remoteControlRequest for a session the user wanted", () => {
  it("turns it on when Claude is available and auto-enable is off", () => {
    const session = {};
    const rec = initReply({
      remote_control_available: true,
      remote_control_auto_enable: false,
    });
    expect(remoteControlRequest(session, rec, true)).toEqual({
      subtype: "remote_control",
      enabled: true,
    });
  });

  it("stays off when Claude says Remote Control is unavailable", () => {
    expect(
      remoteControlRequest(
        {},
        initReply({
          remote_control_available: false,
          remote_control_auto_enable: false,
        }),
        true,
      ),
    ).toBeUndefined();
  });

  it("asks only once per session object", () => {
    const session = {};
    const rec = initReply({
      remote_control_available: true,
      remote_control_auto_enable: false,
    });
    expect(remoteControlRequest(session, rec, true)).toEqual({
      subtype: "remote_control",
      enabled: true,
    });
    expect(remoteControlRequest(session, rec, true)).toBeUndefined();
    expect(remoteControlRequest({}, rec, true)).toEqual({
      subtype: "remote_control",
      enabled: true,
    });
  });
});

describe("remoteControlUnavailable", () => {
  it("is true only for an initialize success saying it is unavailable", () => {
    expect(
      remoteControlUnavailable(initReply({ remote_control_available: false })),
    ).toBe(true);
    expect(
      remoteControlUnavailable(
        initReply({
          remote_control_available: false,
          remote_control_auto_enable: false,
        }),
      ),
    ).toBe(true);
    expect(
      remoteControlUnavailable(initReply({ remote_control_available: true })),
    ).toBe(false);
    expect(
      remoteControlUnavailable(initReply({ remote_control_auto_enable: true })),
    ).toBe(false);
    expect(
      remoteControlUnavailable(
        initReply({ remote_control_available: false }, "error"),
      ),
    ).toBe(false);
    expect(
      remoteControlUnavailable({
        type: "control_response",
        response: { subtype: "success" },
      }),
    ).toBe(false);
  });
});

describe("trackRemoteControl and remoteControlReply", () => {
  it("returns the session link, taking session_url over connect_url", () => {
    const session = {};
    trackRemoteControl(session, "monocode_3", true);
    expect(
      remoteControlReply(
        session,
        controlReply("monocode_3", {
          session_url: "https://claude.ai/code/session_x",
          connect_url: "https://claude.ai/code/connect_y",
        }),
      ),
    ).toEqual({
      enabled: true,
      ok: true,
      url: "https://claude.ai/code/session_x",
    });
  });

  it("falls back to connect_url", () => {
    const session = {};
    trackRemoteControl(session, "monocode_4", true);
    expect(
      remoteControlReply(
        session,
        controlReply("monocode_4", {
          connect_url: "https://claude.ai/code/connect_y",
        }),
      ),
    ).toEqual({
      enabled: true,
      ok: true,
      url: "https://claude.ai/code/connect_y",
    });
  });

  it("drops links that are not https", () => {
    const session = {};
    trackRemoteControl(session, "monocode_5", true);
    expect(
      remoteControlReply(
        session,
        controlReply("monocode_5", {
          session_url: "http://claude.ai/code/session_x",
        }),
      ),
    ).toEqual({ enabled: true, ok: true });

    const other = {};
    trackRemoteControl(other, "monocode_6", true);
    expect(
      remoteControlReply(
        other,
        controlReply("monocode_6", {
          connect_url: "claude.ai/code/connect_y",
        }),
      ),
    ).toEqual({ enabled: true, ok: true });
  });

  it("reports an error reply", () => {
    const session = {};
    trackRemoteControl(session, "monocode_3", true);
    expect(
      remoteControlReply(
        session,
        errorReply("monocode_3", "Remote Control is off for this account"),
      ),
    ).toEqual({
      enabled: true,
      ok: false,
      error: "Remote Control is off for this account",
    });
  });

  it("says whether the tracked request turned it on or off", () => {
    const session = {};
    trackRemoteControl(session, "monocode_8", false);
    expect(remoteControlReply(session, controlReply("monocode_8", {}))).toEqual({
      enabled: false,
      ok: true,
    });
  });

  it("ignores untracked request ids and other session objects", () => {
    const session = {};
    trackRemoteControl(session, "monocode_3", true);
    expect(
      remoteControlReply(session, controlReply("monocode_4", {})),
    ).toBeUndefined();
    expect(
      remoteControlReply({}, controlReply("monocode_3", {})),
    ).toBeUndefined();
  });

  it("answers each tracked request id only once", () => {
    const session = {};
    trackRemoteControl(session, "monocode_3", true);
    const reply = controlReply("monocode_3", {
      session_url: "https://claude.ai/code/session_x",
    });
    expect(remoteControlReply(session, reply)).toBeDefined();
    expect(remoteControlReply(session, reply)).toBeUndefined();
  });

  it("stops asking once a request is tracked", () => {
    const session = {};
    trackRemoteControl(session, "monocode_3", true);
    const rec = initReply({
      remote_control_available: true,
      remote_control_auto_enable: true,
    });
    expect(remoteControlRequest(session, rec)).toBeUndefined();
    expect(remoteControlRequest(session, rec, true)).toBeUndefined();
  });
});
