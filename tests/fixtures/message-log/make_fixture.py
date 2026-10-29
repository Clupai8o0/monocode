#!/usr/bin/env python3
"""Writes the message-log fixture: home/, append-alpha-*.jsonl and expected.json.

Run it from anywhere: python3 tests/fixtures/message-log/make_fixture.py

The Rust reader (src-tauri/src/fork_messages.rs) and the host reader
(host/messages.ts) both run the steps in expected.json against a copy of
home/. The rules are in src/fork/messageLog/messageLogProtocol.ts. The
expected events below are written out by hand; only the text fields are
computed, with the same text rules.

Record order in the transcripts is not always by time, on purpose: a reader
must not depend on it.
"""
import datetime
import json
import os
import re
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
HOME = os.path.join(HERE, "home")
A = "11111111-1111-4111-8111-111111111111"
B = "22222222-2222-4222-8222-222222222222"
MACHINE = "test-mac"
ALPHA = f".claude/projects/-p-alpha/{A}.jsonl"
BETA = f".claude-exec/projects/-p-beta/{B}.jsonl"


def M(n):
    return f"aaaaaaaa-0000-4000-8000-{n:012d}"


def ts(hms):
    return f"2026-10-29T{hms}.000Z"


def ms(hms):
    h, m, s = (int(x) for x in hms.split(":"))
    when = datetime.datetime(2026, 10, 29, h, m, s, tzinfo=datetime.timezone.utc)
    return int(when.timestamp() * 1000)


# ---- text rules (messageLogProtocol.ts, "Text") ----
WS = "\t\n\x0b\x0c\r "
UDS = re.compile(r"uds:[^\t\n\x0b\x0c\r '\"),;]*[^\t\n\x0b\x0c\r '\"),;:.]")
QPATH = re.compile(r"'/[^']*'")


def scrub(s):
    return QPATH.sub("'…'", UDS.sub("uds:…", s))


def preview(body):
    return scrub(body).strip(WS)[:600].rstrip(WS)


def key(body):
    return re.sub(r"[\t\n\x0b\x0c\r ]+", " ", scrub(body).strip(WS))[:160].rstrip(WS)


def summary(s):
    return scrub(s).strip(WS)[:200].rstrip(WS)


def error(s):
    return scrub(s).strip(WS)[:300].rstrip(WS)


# ---- record builders ----
def jl(records):
    return "".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n" for r in records)


def write(path, text):
    full = os.path.join(HERE, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", encoding="utf-8") as fh:
        fh.write(text)


INBOX = ("in that session's inbox, not yet read by its Claude — a [Cross-session delivery notice] "
         "follows if that session holds it (usually a different permission mode) or refuses it")
LOCAL_NOTE = f"another Claude session on this machine; {INBOX}"


class Transcript:
    def __init__(self, sid, cwd):
        self.sid, self.cwd, self.records = sid, cwd, []

    def base(self, kind, at, uuid):
        rec = {"type": kind, "timestamp": ts(at), "sessionId": self.sid, "cwd": self.cwd}
        if uuid:
            rec["uuid"] = uuid
        return rec

    def user_text(self, at, uuid, text):
        rec = self.base("user", at, uuid)
        rec["message"] = {"role": "user", "content": text}
        self.records.append(rec)

    def send(self, tid, at, to, message=None, summary_=None, kind="name", extra=None):
        inp = {"to": to}
        if summary_ is not None:
            inp["summary"] = summary_
        if message is not None:
            inp["message"] = message
        inp.update({"type": "message", "recipient": to, "recipient_kind": kind,
                    "content": (message or "")[:48]})
        if extra:
            inp.update(extra)
        rec = self.base("assistant", at, f"as-{tid}")
        rec["message"] = {"role": "assistant", "content": [
            {"type": "text", "text": "Sending."},
            {"type": "tool_use", "id": tid, "name": "SendMessage", "input": inp}]}
        self.records.append(rec)

    def result(self, tid, at, res, form="record"):
        """form: "record" (toolUseResult set), "parts" (text part only), "string" (content string only)."""
        text = json.dumps(res, ensure_ascii=False, separators=(",", ":"))
        content = text if form == "string" else [{"type": "text", "text": text}]
        rec = self.base("user", at, f"res-{tid}")
        rec["message"] = {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": tid, "content": content}]}
        if form == "record":
            rec["toolUseResult"] = res
        self.records.append(rec)

    def notice(self, at, uuid, text):
        rec = self.base("user", at, uuid)
        rec["isMeta"] = True
        rec["message"] = {"role": "user", "content": text}
        self.records.append(rec)

    def receive(self, at, uuid, frm, name, body, msg_id=None, extra=None, origin=True):
        wrapper = (f"<cross-session-message from=\"{frm}\" from-name=\"{name}\" from-mode=\"bypass\">\n"
                   f"{body}\n</cross-session-message>")
        rec = self.base("user", at, uuid)
        if origin:
            o = {"kind": "peer", "from": frm, "name": name, "fromMode": "bypass", "body": body}
            if msg_id:
                o["msg_id"] = msg_id
            if extra:
                o.update(extra)
            rec["isMeta"] = True
            rec["origin"] = o
            rec["promptSource"] = "peer"
        rec["message"] = {"role": "user", "content": f"Another Claude session sent a message:\n{wrapper}"}
        self.records.append(rec)
        return rec

    def raw(self, rec):
        self.records.append(rec)


def notice_text(phrase, sock, msg_id, tail):
    return (f"[Cross-session delivery notice] Your message to another session was {phrase} "
            f"(recipient: uds:/tmp/cc-socks/{sock}.sock; msg_id: {msg_id}){tail}")


HELD_TAIL = (". NOT delivered: its Claude has not seen it. Do not report it as delivered, do not wait for a "
             "reply, and do not resend while held. The usual cause is that the two sessions run in different "
             "permission modes: a terminal session then asks its user to approve, but a Claude Desktop or "
             "non-interactive session cannot ask, so there the hold expires undelivered unless it is approved.")
BIG_BODY = "🙂" * 10 + " " + "word " * 200
BIG_SUMMARY = "📦" * 205

# ---- alpha: the main account, session A ----
alpha = Transcript(A, "/p/alpha")
alpha.user_text("08:00:00", "u-a-1", "start the review")
alpha.send("toolu_A1", "08:01:00", "beta-2", "Please review   the\nlab diff when you can.", "Ask beta to review")
alpha.result("toolu_A1", "08:01:01", {"success": True, "message": f"“Ask beta to review” → beta-2 ({LOCAL_NOTE})",
                                       "msg_id": M(1), "display": "“Ask beta to review” → sent to beta-2"})
alpha.send("toolu_A2", "08:02:00", "uds:/tmp/cc-socks/1000000900.sock", "Handover: branch msg/ui is pushed.",
           "Hand over to the vivobook", kind="session")
alpha.result("toolu_A2", "08:02:01", {"success": True, "msg_id": M(2), "message":
             f"“Hand over to the vivobook” → uds:/tmp/cc-socks/1000000900.sock; {INBOX}"})
alpha.send("toolu_A3", "08:03:00", "ghost", "Are you there?")
alpha.result("toolu_A3", "08:03:01", {"success": False, "message":
             "No agent named 'ghost' is reachable.\nUse ListAgents to see everyone you can message."}, form="parts")
alpha.send("toolu_A4", "08:04:00", "a07f17a2a0c72f223", "Both skeptics finished.", "Relay results", kind="agent")
alpha.result("toolu_A4", "08:04:01", {"success": True, "message": "Resuming agent a07f17a",
                                       "resumedAgentId": "a07f17a2a0c72f223",
                                       "pin": {"id": "a07f17a2a0c72f223", "name": "a07f17a2a0c72f223", "ref": "2919f8"}})
alpha.send("toolu_A5", "08:05:00", "uds:/tmp/cc-socks/777.sock", "Ping", "Ping old session", kind="session")
alpha.result("toolu_A5", "08:05:01", {"success": False, "message":
             "Failed to send to uds:/tmp/cc-socks/777.sock: ENOENT: no such file or directory, lstat "
             "'/tmp/cc-socks/777.sock' — the peer process may have restarted, so this socket path is stale. "
             "Call ListAgents to get the current address."}, form="string")
alpha.send("toolu_A6", "08:06:00", "gamma", "Can you take the host deploy?", "Ask gamma")
alpha.result("toolu_A6", "08:06:01", {"success": True, "message": f"“Ask gamma” → gamma ({LOCAL_NOTE})", "msg_id": M(4)})
alpha.notice("08:06:30", "n-a-1", notice_text("held by that session", 300, M(4), HELD_TAIL))
alpha.notice("08:09:00", "n-a-2", notice_text("approved and released to that session", 300, M(4), "."))
alpha.send("toolu_A7", "08:10:00", "beta-2", "One more thing", "Follow-up")
alpha.notice("08:11:00", "n-a-3", notice_text("held by that session", 301, M(99), HELD_TAIL))
alpha.raw({"type": "user", "timestamp": ts("08:12:00"), "uuid": "u-a-12", "sessionId": A, "cwd": "/p/alpha",
           "message": {"role": "user", "content": [
               {"type": "text", "text": "what is a cross-session message, and what does \"peer\" mean?"}]}})
alpha.send("toolu_A8", "08:13:00", "scout", "Look at the logs", "Ask scout")
alpha.result("toolu_A8", "08:13:01", {"success": True, "message":
             "Message queued for delivery to scout at its next tool round. If it finishes first, it is resumed "
             "with the message and notifies again, so wait for that notification before resending.",
             "pin": {"id": "a1234567890abcdef0", "name": "scout", "ref": "abc123"}})
alpha.send("toolu_A9", "08:14:00", "uds:/tmp/cc-socks/888.sock", "Status?", "Check in", kind="session")
alpha.result("toolu_A9", "08:14:01", {"success": True, "msg_id": M(9), "message":
             "“Check in” → beta-2 (another Claude session on this machine; in that session's inbox, not yet read by its Claude)"})
alpha.send("toolu_A10", "08:15:00", "beta-2", "Can you also check the APK?", "Late ask")
alpha.result("toolu_A10", "08:15:01", {"success": True, "message": f"“Late ask” → beta-2 ({LOCAL_NOTE})", "msg_id": M(10)})
alpha.notice("08:15:30", "n-a-4", notice_text("held by that session", 200, M(10), HELD_TAIL))
alpha.send("toolu_A11", "08:16:00", "gamma", "Refuse test")
alpha.result("toolu_A11", "08:16:01", {"success": True, "message": f"→ gamma ({LOCAL_NOTE})", "msg_id": M(11)})
alpha.notice("08:16:05", "n-a-5", (
    f"[Cross-session delivery notice] Your message to another session was refused (recipient: "
    f"uds:/tmp/cc-socks/300.sock; msg_id: {M(11)}): that session is not accepting cross-session messages (the "
    "feature is off there, or a setting or policy there refuses them). Not delivered to that session's Claude. "
    "Do not wait for a reply and do not resend; tell the user, or choose another approach."))
alpha.send("toolu_A12", "08:17:00", "beta-2", "Denied test")
alpha.result("toolu_A12", "08:17:01", {"success": True, "message": f"→ beta-2 ({LOCAL_NOTE})", "msg_id": M(12)})
alpha.notice("08:17:40", "n-a-6", notice_text("denied by the recipient user", 200, M(12),
             ". Not delivered to that session's Claude. Do not wait for a reply; continue, or choose another approach."))
alpha.send("toolu_A13", "08:18:00", "beta-2", None, "Subscribe to beta idle", extra={"notify_when_idle": True})
alpha.result("toolu_A13", "08:18:01", {"success": True, "message":
             "Subscribed — \"beta-2\" will send one notice when it is next idle (or exits).", "display": "Subscribed"})
alpha.notice("08:19:00", "n-a-7", "[Cross-session delivery notice] Do not resend now: 1 message to that session is still held.")
alpha.receive("08:20:00", "u-a-18", "uds:/tmp/cc-socks/1000000900.sock", "worker", "Done: msg/ui is merged.",
              "bbbbbbbb-0000-4000-8000-000000000001", {"verifiedPeerPid": 1000000900})
alpha.send("toolu_A14", "08:21:00", "beta-2", "Still there?")
alpha.send("toolu_A15", "08:22:00", "beta-2", BIG_BODY, BIG_SUMMARY)
alpha.result("toolu_A15", "08:22:01", {"success": True, "message": f"→ beta-2 ({LOCAL_NOTE})", "msg_id": M(15)})
alpha.notice("08:30:00", "n-a-8", notice_text("not approved before expiry", 200, M(10), (
    ". Not delivered to that session's Claude, and nothing is waiting there. Do not wait for a reply, and do not "
    "resend unprompted: while the two sessions' permission modes differ a resend is only held again.")))

sub = Transcript(A, "/p/alpha")
sub.send("toolu_SUB", "08:15:00", "beta-2", "From a subagent", "Sub")

# ---- beta: the cx account, session B ----
beta = Transcript(B, "/p/beta")
beta.receive("08:01:05", "u-b-1", "uds:/tmp/cc-socks/100.sock", "alpha-1",
             "Please review   the\nlab diff when you can.", M(1), {"verifiedPeerPid": 100})
beta.raw({"type": "attachment", "timestamp": ts("08:01:04"), "uuid": "at-b-2", "sessionId": B, "cwd": "/p/beta",
          "attachment": {"type": "queued_command", "prompt":
                         "<cross-session-message from=\"uds:/tmp/cc-socks/100.sock\" from-name=\"alpha-1\" "
                         "from-mode=\"bypass\">\nPlease review   the\nlab diff when you can.\n</cross-session-message>"}})
beta.raw({"type": "queue-operation", "operation": "enqueue", "timestamp": ts("08:01:04"), "sessionId": B,
          "content": "<cross-session-message from=\"uds:/tmp/cc-socks/100.sock\" from-name=\"alpha-1\">x</cross-session-message>"})
beta.receive("08:14:05", "u-b-5", "uds:/tmp/cc-socks/100.sock", "alpha-1", "Status?", M(9))
beta.receive("08:30:00", "u-b-3", "bridge:session_01FixtureBridge0001", "clupai-32", "pong from vivobook",
             None, {"hopChain": ["83652e96346c3d376c26fbd8"]})
legacy = beta.receive("08:40:00", None, "uds:/tmp/cc-socks/555.sock", "old-sender", "Legacy hello", origin=False)

# ---- write the home folder ----
if os.path.isdir(HOME):
    shutil.rmtree(HOME)
write(f"home/{ALPHA}", jl(alpha.records))
write(f"home/.claude/projects/-p-alpha/{A}/subagents/agent-a1.jsonl", jl(sub.records))
write("home/.claude/projects/-p-alpha/notes.txt", "not a transcript\n")
beta_text = jl(beta.records)
write(f"home/{BETA}", beta_text)
legacy_line = json.dumps(legacy, ensure_ascii=False, separators=(",", ":")) + "\n"
legacy_offset = len(beta_text.encode("utf-8")[: beta_text.encode("utf-8").index(legacy_line.encode("utf-8"))])


def reg(path, entry):
    write(f"home/{path}", json.dumps(entry, indent=2) + "\n")


def local_entry(pid, sid, cwd, name, status, updated):
    return {"pid": pid, "sessionId": sid, "cwd": cwd, "startedAt": 1793260000000,
            "procStart": "Thu Oct 29 08:00:00 2026", "version": "2.1.0", "kind": "interactive",
            "entrypoint": "cli", "messagingSocketPath": f"/tmp/cc-socks/{pid}.sock", "name": name,
            "status": status, "updatedAt": updated}


def relay_entry(pid, name, account, remote, bridge=None):
    e = {"pid": pid, "sessionId": remote, "cwd": "/home/clupai/proj", "startedAt": 1793260000000,
         "version": "2.1.0", "peerProtocol": 1, "peerFeatures": [], "kind": "interactive", "entrypoint": "relay",
         "pidDomain": "relay:vivobook", "messagingSocketPath": f"/tmp/cc-socks/{pid}.sock", "name": name,
         "nameSource": "derived", "status": "idle", "updatedAt": 1793260950000, "statusUpdatedAt": 1793260950000,
         "monocodeRelay": {"machine": "vivobook", "account": account, "remoteSessionId": remote}}
    if bridge:
        e["bridgeSessionId"] = bridge
    return e


reg(".claude/sessions/100.json", local_entry(100, A, "/p/alpha", "alpha-1", "idle", 1793260800000))
reg(".claude-exec/sessions/200.json", local_entry(200, B, "/p/beta", "beta-2", "busy", 1793260900000))
reg(".claude/sessions/1000000900.json", relay_entry(1000000900, "worker", ".claude", "v-session-0001"))
reg(".claude-exec/sessions/1000000900.json", relay_entry(1000000900, "worker", ".claude", "v-session-0001"))
reg(".claude/sessions/1000000901.json", relay_entry(1000000901, "clupai-32", ".claude-exec", "v-session-0002",
                                                    "session_01FixtureBridge0001"))
reg(".claude/sessions/notes.json.bak", {"not": "a registry file"})
write("home/.claude/sessions/100.key", "SECRET-DO-NOT-READ\n")

# ---- appended later, in two parts (the first ends inside a line) ----
late = Transcript(A, "/p/alpha")
late.result("toolu_A7", "08:10:02", {"success": True, "message": f"“Follow-up” → beta-2 ({LOCAL_NOTE})", "msg_id": M(7)})
late.receive("08:50:00", "u-a-50", "uds:/tmp/cc-socks/200.sock", "beta-2", "Reviewed: looks good.",
             "cccccccc-0000-4000-8000-000000000001")
later = Transcript(A, "/p/alpha")
later.receive("08:55:00", "u-a-55", "bridge:session_unknown0002", "phone-1", "From the phone")
later_line = jl(later.records)
cut = later_line.index('"origin"') + 4
with open(os.path.join(HERE, "append-alpha-1.jsonl"), "w", encoding="utf-8") as fh:
    fh.write(jl(late.records) + later_line[:cut])
with open(os.path.join(HERE, "append-alpha-2.jsonl"), "w", encoding="utf-8") as fh:
    fh.write(later_line[cut:])

# ---- expected events ----
LOCAL_A = {"machine": MACHINE, "sessionId": A, "account": "main", "name": "alpha-1", "route": "local"}
LOCAL_B = {"machine": MACHINE, "sessionId": B, "account": "cx", "name": "beta-2", "route": "local"}
RELAY_W = {"machine": "vivobook", "sessionId": "v-session-0001", "account": "main", "name": "worker", "route": "relay"}
BRIDGE_C = {"machine": "vivobook", "sessionId": "v-session-0002", "account": "cx", "name": "clupai-32", "route": "bridge"}


def send_ev(tid, at, updated, to, address, body, status, rev=1, summary_=None, target=None, msg_id=None,
            to_name=None, err=None):
    e = {"kind": "send", "id": f"{A}:{tid}", "rev": rev, "at": ms(at), "updatedAt": ms(updated), "sessionId": A,
         "account": "main", "to": to, "toAddress": address}
    if to_name:
        e["toName"] = to_name
    if target:
        e["target"] = target
    if summary_:
        e["summary"] = summary(summary_)
    e.update({"preview": preview(body), "key": key(body)})
    if msg_id:
        e["msgId"] = msg_id
    e["status"] = status
    if err:
        e["error"] = err
    return e


def recv_ev(sid, account, rid, at, address, body, rev=1, from_name=None, sender=None, msg_id=None):
    e = {"kind": "receive", "id": f"{sid}:{rid}", "rev": rev, "at": ms(at), "updatedAt": ms(at), "sessionId": sid,
         "account": account}
    if from_name:
        e["fromName"] = from_name
    e["fromAddress"] = address
    if sender:
        e["sender"] = sender
    e.update({"preview": preview(body), "key": key(body)})
    if msg_id:
        e["msgId"] = msg_id
    return e


first = [
    send_ev("toolu_A1", "08:01:00", "08:01:01", "beta-2", "name", "Please review   the\nlab diff when you can.",
            "sent", summary_="Ask beta to review", target=LOCAL_B, msg_id=M(1)),
    recv_ev(B, "cx", "u-b-1", "08:01:05", "socket", "Please review   the\nlab diff when you can.",
            from_name="alpha-1", sender=LOCAL_A, msg_id=M(1)),
    send_ev("toolu_A2", "08:02:00", "08:02:01", "", "socket", "Handover: branch msg/ui is pushed.", "sent",
            summary_="Hand over to the vivobook", target=RELAY_W, msg_id=M(2)),
    send_ev("toolu_A3", "08:03:00", "08:03:01", "ghost", "name", "Are you there?", "failed",
            err=error("No agent named 'ghost' is reachable.\nUse ListAgents to see everyone you can message.")),
    send_ev("toolu_A5", "08:05:00", "08:05:01", "", "socket", "Ping", "failed", summary_="Ping old session",
            err=error("Failed to send to uds:/tmp/cc-socks/777.sock: ENOENT: no such file or directory, lstat "
                      "'/tmp/cc-socks/777.sock' — the peer process may have restarted, so this socket path is "
                      "stale. Call ListAgents to get the current address.")),
    send_ev("toolu_A6", "08:06:00", "08:09:00", "gamma", "name", "Can you take the host deploy?", "released",
            summary_="Ask gamma", msg_id=M(4)),
    send_ev("toolu_A7", "08:10:00", "08:10:00", "beta-2", "name", "One more thing", "pending",
            summary_="Follow-up", target=LOCAL_B),
    send_ev("toolu_A9", "08:14:00", "08:14:01", "", "socket", "Status?", "sent", summary_="Check in",
            target=LOCAL_B, msg_id=M(9), to_name="beta-2"),
    recv_ev(B, "cx", "u-b-5", "08:14:05", "socket", "Status?", from_name="alpha-1", sender=LOCAL_A, msg_id=M(9)),
    send_ev("toolu_A10", "08:15:00", "08:30:00", "beta-2", "name", "Can you also check the APK?", "expired",
            summary_="Late ask", target=LOCAL_B, msg_id=M(10)),
    send_ev("toolu_A11", "08:16:00", "08:16:05", "gamma", "name", "Refuse test", "failed", msg_id=M(11),
            err="Refused: that session is not accepting messages from other sessions"),
    send_ev("toolu_A12", "08:17:00", "08:17:40", "beta-2", "name", "Denied test", "failed", target=LOCAL_B,
            msg_id=M(12), err="Denied by that session's user"),
    recv_ev(A, "main", "u-a-18", "08:20:00", "socket", "Done: msg/ui is merged.", from_name="worker",
            sender=RELAY_W, msg_id="bbbbbbbb-0000-4000-8000-000000000001"),
    send_ev("toolu_A14", "08:21:00", "08:21:00", "beta-2", "name", "Still there?", "pending", target=LOCAL_B),
    send_ev("toolu_A15", "08:22:00", "08:22:01", "beta-2", "name", BIG_BODY, "sent", summary_=BIG_SUMMARY,
            target=LOCAL_B, msg_id=M(15)),
    recv_ev(B, "cx", "u-b-3", "08:30:00", "bridge", "pong from vivobook", from_name="clupai-32", sender=BRIDGE_C),
    recv_ev(B, "cx", f"r{legacy_offset}", "08:40:00", "socket", "Legacy hello", from_name="old-sender"),
]
a7_sent = send_ev("toolu_A7", "08:10:00", "08:10:02", "beta-2", "name", "One more thing", "sent", rev=2,
                  summary_="Follow-up", target=LOCAL_B, msg_id=M(7))
u_a_50 = recv_ev(A, "main", "u-a-50", "08:50:00", "socket", "Reviewed: looks good.", rev=2, from_name="beta-2",
                 sender=LOCAL_B, msg_id="cccccccc-0000-4000-8000-000000000001")
u_a_55 = recv_ev(A, "main", "u-a-55", "08:55:00", "bridge", "From the phone", rev=3, from_name="phone-1")
final = sorted([a7_sent if e["id"] == a7_sent["id"] else e for e in first] + [u_a_50, u_a_55],
               key=lambda e: (e["at"], e["id"]))
in_last_hour = [e for e in final if e["at"] >= ms("08:30:00")]

expected = {
    "about": ("Run the steps in order against one reader, on a copy of home/ (copying gives fresh mtimes). "
              "Liveness: every registry entry that is not a relay copy is live. Compare whole answers except "
              "epoch: optional fields left out, events sorted by (at, id)."),
    "machine": MACHINE,
    "forbidden": ["cc-socks", "uds:/", "SECRET", "1000000900"],
    "sessions": [
        {"sessionId": A, "account": "main", "name": "alpha-1", "cwd": "/p/alpha", "project": "alpha",
         "status": "idle", "updatedAt": 1793260800000},
        {"sessionId": B, "account": "cx", "name": "beta-2", "cwd": "/p/beta", "project": "beta",
         "status": "busy", "updatedAt": 1793260900000},
    ],
    "proxies": [
        {"name": "worker", "machine": "vivobook", "sessionId": "v-session-0001", "account": "main"},
        {"name": "clupai-32", "machine": "vivobook", "sessionId": "v-session-0002", "account": "cx"},
    ],
    "steps": [
        {"name": "first scan", "now": ts("09:00:00"), "params": {},
         "expect": {"full": True, "cursor": 1, "windowHours": 24, "events": first}},
        {"name": "a result and a receive appended, then half a line", "now": ts("09:00:00"),
         "append": [{"to": f"home/{ALPHA}", "from": "append-alpha-1.jsonl"}], "params": {"since": "previous"},
         "expect": {"full": False, "cursor": 2, "windowHours": 24, "events": [a7_sent, u_a_50]}},
        {"name": "the rest of the line", "now": ts("09:00:00"),
         "append": [{"to": f"home/{ALPHA}", "from": "append-alpha-2.jsonl"}], "params": {"since": "previous"},
         "expect": {"full": False, "cursor": 3, "windowHours": 24, "events": [u_a_55]}},
        {"name": "nothing new", "now": ts("09:00:00"), "params": {"since": "previous"},
         "expect": {"full": False, "cursor": 4, "windowHours": 24, "events": []}},
        {"name": "another epoch gets everything", "now": ts("09:00:00"),
         "params": {"since": {"epoch": "not-this-one", "cursor": 2}},
         "expect": {"full": True, "cursor": 5, "windowHours": 24, "events": final}},
        {"name": "a one hour window", "now": ts("09:30:00"), "params": {"windowHours": 1},
         "expect": {"full": True, "cursor": 6, "windowHours": 1, "events": in_last_hour}},
    ],
}
with open(os.path.join(HERE, "expected.json"), "w", encoding="utf-8") as fh:
    json.dump(expected, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
print(f"wrote fixture: {len(first)} events, then {len(final)}; legacy receive at byte {legacy_offset}")
