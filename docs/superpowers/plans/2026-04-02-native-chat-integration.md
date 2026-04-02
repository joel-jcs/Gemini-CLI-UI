# Native Chat Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the Gemini CLI UI to use native Gemini CLI `.jsonl` files as the single source of truth for all chat sessions and history, enabling full bidirectional synchronization.

**Architecture:**
1.  **Storage**: Discontinue use of the private `sessionManager` for project-based chats.
2.  **Parsing**: Implement robust `.jsonl` parsing in `server/projects.js` to reconstruct sessions and message history from native CLI files.
3.  **Resumption**: Utilize the native `gemini --resume <sessionId>` flag in `server/gemini-cli.js` for all ongoing conversations.

**Tech Stack:** Node.js (Express), Gemini CLI, JSONL Parsing.

---

### Task 1: Refactor `getSessions` for Native-First Discovery

**Files:**
- Modify: `server/projects.js`

- [ ] **Step 1: Update `getSessions` to scan all `.jsonl` files in a project**
    Modify the loop in `getSessions` to ensure it correctly identifies all unique `sessionId` values across multiple `.jsonl` files (as the CLI sometimes creates new files).

```javascript
// Inside server/projects.js -> getSessions
// Replace current logic with a unified map of sessionIds
const allSessions = new Map();
for (const file of sessionFiles) {
  const filePath = path.join(projectDir, file);
  const fileSessions = await parseJsonlSessions(filePath);
  fileSessions.forEach(session => {
    if (!allSessions.has(session.id)) {
      allSessions.set(session.id, session);
    } else {
      // Merge: update lastActivity if this file has more recent data
      const existing = allSessions.get(session.id);
      if (new Date(session.lastActivity) > new Date(existing.lastActivity)) {
        allSessions.set(session.id, session);
      }
    }
  });
}
```

- [ ] **Step 2: Commit**
```bash
git add server/projects.js
git commit -m "feat: refactor getSessions to unify all native .jsonl sessions"
```

---

### Task 2: Implement Native Message Retrieval in `getSessionMessages`

**Files:**
- Modify: `server/projects.js`

- [ ] **Step 1: Update `getSessionMessages` to parse JSONL entries into UI-compatible messages**
    The UI expects a specific message structure. Ensure the parser handles role mapping correctly.

```javascript
// Inside server/projects.js -> getSessionMessages
// Ensure the parsing handles native JSONL structure:
// entry.message.role -> UI role
// entry.message.content -> UI content
// entry.timestamp -> UI timestamp
for await (const line of rl) {
  if (line.trim()) {
    try {
      const entry = JSON.parse(line);
      if (entry.sessionId === sessionId && entry.message) {
        messages.push({
          sessionId: sessionId,
          type: entry.message.role === 'assistant' ? 'assistant' : 'user',
          message: {
            role: entry.message.role,
            content: entry.message.content
          },
          timestamp: entry.timestamp || new Date().toISOString()
        });
      }
    } catch (e) {}
  }
}
```

- [ ] **Step 2: Commit**
```bash
git add server/projects.js
git commit -m "feat: update getSessionMessages to parse native JSONL format"
```

---

### Task 3: Refactor `spawnGemini` to use Native Resumption

**Files:**
- Modify: `server/gemini-cli.js`

- [ ] **Step 1: Remove manual context building and add `--resume` flag**
    Instead of using `sessionManager.buildConversationContext`, pass the `sessionId` directly to the CLI.

```javascript
// Inside server/gemini-cli.js -> spawnGemini
// Remove: const context = sessionManager.buildConversationContext(sessionId);
// Add:
if (sessionId) {
  args.push('--resume', sessionId);
}
if (command && command.trim()) {
  args.push('--prompt', command);
}
```

- [ ] **Step 2: Remove local `sessionManager.addMessage` calls**
    The CLI will now handle updating the `.jsonl` files itself when it runs with the `--resume` flag.

- [ ] **Step 3: Commit**
```bash
git add server/gemini-cli.js
git commit -m "feat: refactor spawnGemini to use native --resume flag"
```

---

### Task 4: Connect API Endpoints and Deprecate Local Storage

**Files:**
- Modify: `server/index.js`

- [ ] **Step 1: Update API routes to use `projects.js` instead of `sessionManager`**
    Ensure the sessions and messages endpoints call the newly refactored native logic.

```javascript
// server/index.js
// Update /api/projects/:projectName/sessions/:sessionId/messages
app.get("/api/projects/:projectName/sessions/:sessionId/messages", authenticateToken, async (req, res) => {
  try {
    const { projectName, sessionId } = req.params;
    const messages = await getSessionMessages(projectName, sessionId); // Call projects.js instead of sessionManager
    res.json({ messages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

- [ ] **Step 2: Commit**
```bash
git add server/index.js
git commit -m "feat: redirect API endpoints to native project storage"
```

---

### Task 5: Final Validation

- [ ] **Step 1: Verify native discovery**
    Open the UI and confirm that the "54 chats" are now visible in the project sidebar.
- [ ] **Step 2: Verify bidirectional sync**
    1. Send a message from the UI in a native chat.
    2. Open a terminal and run `gemini /resume`.
    3. Verify the message is present in the terminal history.
- [ ] **Step 3: Verify clean session creation**
    Start a "New Session" in the UI, don't send a message, and verify no `.jsonl` file is created until the first prompt.
