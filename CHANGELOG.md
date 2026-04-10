# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
