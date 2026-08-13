# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.9.3] - 2026-08-13

### Fixed
- Reduce CPU and rendering overhead in long streaming sessions by throttling Markdown updates, avoiding unnecessary timeline regrouping, and sharing the active SSE connection (#449)

## [0.9.2] - 2026-05-29

### Fixed
- Restore session and thinking-state recovery after dropped SSE connections (#425, #429, #431, #433)
- Keep project busy badges accurate after reconnects, stale status seeds, and deleted sessions (#436)
- Stabilize provider authentication, OpenAI notebook auth handling, and provider refresh after auth changes (#437, #438)
- Prevent UI startup and session-load hangs with API health-check timeouts and proxy connection cleanup (#441, #442)
- Refresh stale directory-scoped provider state when global provider credentials become available (#443)
- Optimistically remove deleted sessions from the sidebar (#428)

### Changed
- Update OpenCode CLI used by the Kubeflow image and session completion polling (#434, #435)
- Switch the notebook image to a Debian base (#440)

## [0.9.1] - 2026-05-14

### Added
- Add Telegram bridge service, settings, setup guide, commands, notifications, inline controls, multi-source support, and session alarm routing (#252, #256, #257, #265, #269, #272, #282, #286, #287, #288, #290, #293, #300, #304, #312, #318, #321, #329, #330, #332, #337, #347, #354, #375)
- Add follow-up queue controls, auto-send mode, reorder support, and drag-and-drop reordering (#275, #298, #352, #377)
- Add model metadata hover popup, model variant picker, grouped/collapsible model picker options, and provider disconnect actions (#270, #313, #349, #390, #406)
- Render additional message parts including agent, snapshot, retry, patch, compaction, and subtask delegation cards (#306, #308, #336)
- Add auto-accept permissions toggle and review panel diff modes (#307, #412)
- Show active tool details in the message stream (#414)

### Fixed
- Preserve terminal sessions, saved prompt behavior, Telegram runtime state, prompt delivery, and Telegram alert routing across session changes and reconnects (#253, #258, #259, #274, #292, #305, #358, #365)
- Stabilize chat sync, SSE noise, streaming autoscroll, tool invocation summaries, and tool state refresh during sync (#401, #410, #411, #416, #419, #421)
- Improve OpenAI auth in remote UI, provider disconnect handling, MCP URL guidance, and Kubeflow OpenCode CLI pinning (#403, #409, #423, #395)
- Harden proxy decoding, stale Workbox bootstrap, worktree lifecycle events, and session creation edge cases (#361, #373, #310, #271)
- Restore markdown code block copy affordances and apply_patch diff rendering (#360, #371, #389, #408)
- Update frontend audit dependencies and test/runtime compatibility (#405, #398, #399)

## [0.9.0] - 2026-04-10

### Added
- Add multi-server MCP support with API key and Basic Auth authentication (#196)
- Add server-side proxy for remote MCP server connections (#199)
- Add Servers tab to Settings with API Key field for MCP, skip GlobalEvents for remote servers (#202)
- Add GitHub Release creation with auto-generated notes to tag workflow (#186)
- Pass message timing, token, and model data through to DisplayMessage and Turn types (#175)
- Add drag-to-resize handle for chat input textarea (#170)
- Add timestamp display and expandable details panel to message turns (#176)
- Preinstall GitHub CLI and pinned `gh-copilot-review` extension in the Kubeflow image (#194)

### Fixed
- Track model selection per session instead of globally (#212)
- Filter disabled providers in frontend and preserve disabled_providers in config rewrites (#211)
- Fix saved prompts not displaying in Settings > Prompts tab (#210)
- Namespace model selection localStorage key by project directory (#207)
- Handle CORS preflight in proxy, route test connection through proxy (#200)
- Strip Content-Encoding from proxy responses (#201)
- Guard import.meta.env access for non-Vite builds (#198)
- Fix SSE parser: flush after stream ends, handle trailing CR, O(n) CRLF normalization
- Fix auth credential storage: split metadata to localStorage and credentials to sessionStorage, preserve auth method across browser restarts, trim credentials
- Fix saved prompts written to wrong localStorage key during navigation (#187)
- Fix session unarchive not working due to undefined being stripped by JSON.stringify (#189)
- Remove backdrop-click dismiss from form dialogs to prevent accidental data loss (#171)
- Fix drag-to-dismiss bug on non-form dialogs (#172)
- Fix newly created saved prompt not appearing in prompt list until page refresh (#174)
- Preserve per-session draft input text, file context, and image attachments across session switches (#173)
- Remove 600px max-height cap on terminal panel drag resize, use viewport-based limit instead (#169)

### Changed
- Remove per-PR changelog entry requirement from AGENTS.md (#191)

## [0.8.2] - 2026-03-11

### Added
- Bubble sub-agent permission and question requests up to parent session (#163)

### Fixed
- Filter sub-agent sessions from project activity badges (#162)
- Prevent permission toggle from reverting after server.connected refresh (#161)
- Use backend config API for instructions creation (#160)
- Persist MCP server enabled state to config on toggle (#160)
- Ensure MCP status refresh runs even if config update fails (#160)
- Log warning on MCP config persistence failure (#160)

## [0.8.1] - 2026-03-09

_Initial tagged release._
