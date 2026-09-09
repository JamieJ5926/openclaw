---
summary: "The composer capability menu: skills, connectors, web search, and tool access"
read_when:
  - Enabling skills or connectors for one session
  - Adding an MCP server from the composer
  - Attaching files or video in chat
title: "Composer capability menu"
sidebarTitle: "Composer"
---

The **+** menu beside the composer, and the sparse session overrides it writes.

## Composer capability menu

Select **+** beside the chat composer to open attachments and session capabilities in one menu:

- **Skills** enables or disables individual skills for this session.
- **Connectors** enables or disables configured MCP servers for this session. A **session** tag marks values that differ from the inherited configuration. **Browse connectors** opens the Plugins page on **Discover**.
- **Web search** enables or disables managed web search plus native OpenAI and Codex search for this session.
- **Manage plugins** opens the Plugins page.

These controls are sparse session overrides, like the model and thinking settings in the chat header. A capability with no override inherits the current agent or global configuration, and OpenClaw applies the resolved values when the next run materializes its tools and skills. The **N session overrides** pill in the composer footer reopens the menu; select its clear action to remove all capability overrides in one click.

Video files selected in Chat or New Session show a small local frame preview with a play badge beside the filename. The slot keeps its size while loading. If the browser cannot decode the video promptly, the play icon remains. Removing the attachment releases its preview; generating the preview does not upload the video.

In **Connectors**, administrators can select **Add MCP server…** and choose a scope. **This session** saves the server definition globally but disabled by default, then enables it only for the current session. **Everywhere** saves the definition enabled globally. Transport, authentication, and other server-definition fields are always global. Session policy can override server enablement and deny individual tools through **Tool access**.

**Tool access** lists a connector's tools once a run has discovered them. Before that, it explains why the list is empty rather than reporting zero tools: a newly added server has not connected yet, a connected server has not finished listing its tools, or the runtime catalog predates a config change. Sessions that run on the Codex harness keep their MCP connections inside Codex, so their tools do not appear here.

Capability toggles stay disabled until the Gateway, session, and runtime config are loaded, and read-only operators cannot change them. Adding a server requires administrator access. See [Connect MCP servers](/tools/mcp) for the Settings, CLI, and config paths.
