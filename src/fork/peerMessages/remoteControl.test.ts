import { describe, expect, it } from "vitest";
import { remoteControlRequest } from "./remoteControl";

function initReply(reply: Record<string, unknown>, subtype = "success") {
  return {
    type: "control_response",
    response: { subtype, request_id: "monocode_1", response: reply },
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
