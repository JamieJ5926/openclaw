---
summary: "The session rail, side chat, and session links in messages"
read_when:
  - Watching a running session from the rail
  - Asking side chat about a session
  - Following a session link in a message
title: "Session rail and side chat"
sidebarTitle: "Session rail"
---

The session rail, the read-only side chat thread beside it, and how session links in messages resolve.

## Session rail and side chat

While you watch a running session, the Gateway shows the model's latest safe preamble immediately as the session headline. When a utility model is available, it can replace that headline with a richer compact status digest after enough activity accumulates. Chat carries the result in a **session rail**: its compact pill shows the live digest, while the expanded rail shows the assessment, plan progress, pull requests, elapsed time, and a read-only Side chat thread. The rail can expand once when a run becomes stuck or needs input, and done or failed runs keep a frozen “finished” time based on the final digest. On wide chat panes the expanded rail docks as a 400 px right column; on narrower and mobile layouts it remains an overlay.

Side chat answers questions about the selected session and its project without entering or interrupting the main agent run. On the first question, the Gateway lazily loads a bounded visible snapshot of the selected session before starting the utility model. If history is temporarily unavailable, the question stays visible with **Retry** instead of being treated as an empty session. Side chat uses read-only access to the target session's history/search and agent workspace. Its bounded thread is held in Gateway memory, is restored when you switch sessions in the Control UI, and is cleared by the rail's trash button, a session reset or deletion, Gateway restart, or idle expiry. It never enters `chat.history`, and private reference context is not stored as operator dialogue. Open it with Shift-Command-S on Apple platforms or Ctrl-Shift-S elsewhere, or type `/btw <question>` or `/side <question>` in the main Control UI composer to open the rail and ask there; other clients keep their existing BTW behavior.

Highlighting text in a chat message offers **Ask in side chat**, which opens the rail with a quoted draft ready to edit.

The headline owns that run's sidebar subtitle instead of heuristic live activity. It is shared with the official iOS and Android session lists. A final done or failed digest remains visible while the session is unread, then the row returns to its normal work subtitle.

Session observation is enabled by default. Safe preamble headlines do not require a utility model; the utility model only owns richer assessments and terminal summaries. In **Settings > Appearance > Sidebar**, you can turn observation off gateway-wide, inspect the resolved small model and its provenance, or choose automatic routing, disable utility tasks, or select an explicit `agents.defaults.utilityModel`. The equivalent config controls are `gateway.controlUi.sessionObserver: false` and `agents.defaults.utilityModel: ""`.

## Session links in messages

Session links in messages open inside the Control UI. This includes `agent:` keys,
root-relative chat URLs, and URLs on the current origin or the Gateway's public origin
when its applied configuration is loaded. Hovering a link shows the session card
when the session is known locally. Unknown or ambiguous session references remain
navigable without a card; links to other origins keep normal browser behavior.
Document-relative hrefs are never session links; file references such as
`src/utils/foo.ts` retain workspace file handling.
