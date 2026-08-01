#!/usr/bin/env python3
"""Codex App Server transport tests; no real Codex turn is launched."""
import sys
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "server"))

from nth_codex_runtime import (CodexAppServerClient, CodexProtocolError,
                               build_app_server_argv)

failures = 0


def check(label, condition):
    global failures
    print(("PASS" if condition else "FAIL") + ": " + label)
    if not condition:
        failures += 1


notifications = []
requests = []
got_turn = threading.Event()


def on_notification(message):
    notifications.append(message)
    if message.get("method") == "turn/completed":
        got_turn.set()


def on_server_request(message):
    requests.append(message)
    return {"decision": "decline"}


client = CodexAppServerClient(
    command=[sys.executable, str(HERE / "fake_codex_app_server.py")],
    on_notification=on_notification,
    on_server_request=on_server_request,
)
try:
    init = client.start()
    check("initialize handshake returns server metadata",
          init.get("platformOs") == "test" and client.alive())
    check("client exposes the live shared process pid", bool(client.pid))

    account = client.request("account/read", {"refreshToken": False})
    check("account/read response is correlated", account.get("account", {}).get("type") == "chatgpt")
    models = client.request("model/list", {"limit": 20, "includeHidden": False})
    check("model/list returns provider capabilities",
          models.get("data", [{}])[0].get("defaultReasoningEffort") == "low")
    mcp = client.request("mcpServerStatus/list", {"limit": 50, "detail": "toolsAndAuthOnly"})
    check("Trio MCP status and tools are visible",
          mcp.get("data", [{}])[0].get("name") == "nth-trio"
          and "trio_send" in mcp["data"][0].get("tools", {}))

    thread = client.request("thread/start", {"model": "fake-codex"})["thread"]
    client.request("turn/start", {"threadId": thread["id"], "input": [
        {"type": "text", "text": "hello"}]})
    got_turn.wait(2.0)
    methods = [n.get("method") for n in notifications]
    check("thread and turn notifications stream independently of responses",
          "thread/started" in methods and "item/completed" in methods
          and "turn/completed" in methods)

    try:
        client.request("explode")
        errored = False
    except CodexProtocolError as exc:
        errored = "boom" in str(exc)
    check("JSON-RPC errors become bounded protocol exceptions", errored)

    client.request("emit/request")
    check("server-initiated requests reach the host decision callback",
          requests and requests[0].get("method") == "item/commandExecution/requestApproval")
finally:
    client.stop()

check("stop terminates the App Server process", not client.alive() and client.pid is None)

argv = build_app_server_argv("/tmp/nth server.py", python_cmd="py3")
joined = " ".join(argv)
check("production argv injects required nth-trio MCP config",
      argv[:2] == ["codex", "app-server"]
      and "mcp_servers.nth-trio.required=true" in argv
      and "/tmp/nth server.py" in joined)

print(f"\n{'OK' if failures == 0 else 'FAILED'} — {failures} failure(s)")
raise SystemExit(1 if failures else 0)
