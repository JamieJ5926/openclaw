---
summary: "Chat transcript layout and message width"
read_when:
  - Adjusting transcript layout
  - Changing chat message width
title: "Transcript layout and width"
sidebarTitle: "Layout and width"
---

Layout controls for the transcript and the saved message width.

## Chat transcript layout

The chat transcript uses a centered readable frame aligned with the composer. Assistant and tool output stay left-aligned while your own messages stay right-aligned inside that frame. In multi-user sessions (for example a group chat relayed from a channel plugin), messages from other attributed participants render left-aligned with the author's avatar, name, and a stable per-identity color, so only the signed-in viewer's messages read as "mine". When two or more attributed participants are present, assistant replies carry a small "Replying to name" marker naming the participant whose message triggered the turn. System entries such as local slash-command output render as centered notice rows without an avatar.

Images and video previews in your own messages appear above any accompanying text, without a surrounding bubble background. Videos use a still frame with a play icon; select the preview to open the video in the Files panel. If a preview cannot load, the attachment card remains available. Hovering media leaves that layout unchanged, and the text keeps its normal bubble color, including any per-identity tint. Assistant videos retain their inline player.

Messages forwarded by `sessions_send` render as left-aligned speech bubbles with a source-session chip above the message. When avatars are shown, messages from a different known agent use that agent's avatar, or initials in a stable identity color if no avatar is available. Same-agent forwards and unknown senders keep the forward icon. Select the chip to open the source session; hover it to see session progress. Each source session has a stable bubble tint. Forwarded messages without a known source session show the source agent when available, or a generic forwarded-message label. The receiving agent's own replies remain flat text.

## Chat message width

Drag the side-panel divider to resize a task's **Review** transcript. Messages
and expanded tool input reflow within the panel, keeping tool-card borders visible.

Wide-monitor users can override the transcript width under **Settings → Appearance → Chat →
Message width**. The preference stays in that browser's local storage. Supported
forms include plain lengths and percentages such as `960px` or `82%`, plus
constrained `min(...)`, `max(...)`, `clamp(...)`, `calc(...)`, and
`fit-content(...)` width expressions supported by your browser. Invalid input
shows an error and keeps the last saved width. Clear the field to restore the default.
