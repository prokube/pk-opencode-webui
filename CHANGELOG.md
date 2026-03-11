# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.8.2] - 2026-03-11

### Added
- Bubble sub-agent permission and question requests up to parent session (#163)

### Fixed
- Filter sub-agent sessions from project activity badges (#162)
- Prevent permission toggle from reverting after server.connected refresh (#161)
- Use backend config API for instructions creation (#160)
- Persist MCP server enabled state to config on toggle
- Ensure MCP status refresh runs even if config update fails
- Log warning on MCP config persistence failure

## [0.8.1] - 2026-03-09

_Initial tagged release._
