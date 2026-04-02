# Native Chat Integration Design - Gemini CLI UI

## Executive Summary
- **Objective**: Unify the Gemini CLI UI with the native `gemini` CLI storage system, ensuring 100% synchronization and bidirectional compatibility.
- **Scope**: Refactor the backend to use native `.jsonl` files as the primary source of truth for chat history, sessions, and project data.
- **Risk Level**: Medium (requires robust parsing of CLI-generated JSONL files).

## Current State Analysis
- **Existing Implementation**: The UI maintains an isolated `sessionManager` in `~/.gemini/sessions/` using separate `.json` files.
- **Pain Points**: Native conversations (created via terminal) are invisible in the UI. UI-created chats are invisible to the terminal's `/resume` command.
- **Technical Debt**: Duplicated session storage logic and lack of native CLI flag usage (`--resume`).

## Proposed Solution: Approach 1 (Direct CLI Wrapper)
The UI will abandon its private `sessionManager` for project-based chats and instead "bridge" directly into the Gemini CLI's native file structure and command-line interface.

### Architecture Overview
1.  **Unified Storage**: All session data will be read from and written to `~/.gemini/projects/<project-name>/*.jsonl`.
2.  **Native Resumption**: The backend will use the `gemini --resume <sessionId>` flag for all ongoing conversations.
3.  **Real-time Parsing**: The backend will parse native `.jsonl` lines to build message history for the frontend.

### Key Design Decisions
- **Source of Truth**: The filesystem (`~/.gemini/projects/`) replaces the internal memory/JSON cache for session history.
- **Session Lifecycle**: Empty sessions are not persisted to disk until the first message is sent, maintaining CLI parity.
- **Synchronization**: Leverages the existing `chokidar` file watcher to detect when the CLI (running in a terminal) updates a session file, triggering a UI refresh.

### Data Flow
1.  **Discovery**: `getProjects` scans `~/.gemini/projects/` for folders and `projects.json` for registered paths.
2.  **Listing**: `getSessions` parses `.jsonl` files in the project folder to identify unique `sessionId` entries and their metadata (summary, last activity).
3.  **Loading**: `getSessionMessages` streams and parses the specific `.jsonl` lines associated with a `sessionId`.
4.  **Interaction**: `spawnGemini` executes the CLI with the `--resume <sessionId>` flag, allowing the native tool to handle history management and file updates.

## Validation & Testing Strategy
- **Compatibility Test**: Verify that a session started in the UI appears in `gemini /resume` in the terminal.
- **Synchronization Test**: Verify that messages sent via terminal appear in the UI without a manual refresh.
- **Parsing Test**: Ensure complex `.jsonl` entries (tool calls, errors, long responses) are rendered correctly in the UI.

## Future Considerations
- **Performance**: For extremely large projects (hundreds of sessions), we may need to implement a lightweight SQLite index for the `.jsonl` metadata to speed up sidebar loading.
- **Native Support**: The design anticipates supporting both "Managed Projects" (in `projects/`) and "Native Tmp Projects" (in `tmp/<hash>/`).
