#!/usr/bin/env python3
"""A fake headless agent that speaks just enough of Claude Code's stream-json
protocol to exercise nth_supervisor WITHOUT a real, billed `claude` session.

Behaviour:
  * On start, emits a `system/init` line carrying a session_id. If launched
    with `--resume <id>`, it reports THAT id back (proving resume plumbing).
  * Reads stream-json `user` messages on stdin and echoes each back as an
    `assistant` message. EOF on stdin ends the process.

Pointed at via $TRIO_AGENT_CMD in tests.
"""
import json
import sys


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main() -> int:
    argv = sys.argv[1:]
    resume = ""
    model = ""
    for i, a in enumerate(argv):
        if a == "--resume" and i + 1 < len(argv):
            resume = argv[i + 1]
        elif a == "--model" and i + 1 < len(argv):
            model = argv[i + 1]

    session_id = resume or f"sess-fake-{model or 'default'}-001"
    emit({"type": "system", "subtype": "init",
          "session_id": session_id, "model": model,
          "resumed": bool(resume)})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        content = ""
        if isinstance(msg, dict):
            m = msg.get("message") or {}
            content = m.get("content", "") if isinstance(m, dict) else ""
        emit({"type": "assistant",
              "message": {"role": "assistant",
                          "content": f"echo: {content}"},
              "session_id": session_id})
    return 0


if __name__ == "__main__":
    sys.exit(main())
