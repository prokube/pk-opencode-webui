# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Pass message timing, token, and model data through to DisplayMessage and Turn types (#175)
- Add CHANGELOG.md and require changelog entries in PRs (#165)

### Changed

### Fixed
- Remove backdrop-click dismiss from form dialogs to prevent accidental data loss (#171)
- Clear chat input text when switching sessions (#167)
- Remove 600px max-height cap on terminal panel drag resize, use viewport-based limit instead (#169)

### Removed

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
