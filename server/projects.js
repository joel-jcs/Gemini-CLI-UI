import { promises as fs } from "fs";
import fsSync from "fs";
import path from "path";
import readline from "readline";
import os from "os";
import crypto from "crypto";

// Helper to get Gemini home directory reliably across platforms
function getGeminiDir() {
  const home = os.homedir();
  return path.join(home, ".gemini");
}

// Cache for extracted project directories
const projectDirectoryCache = new Map();
let cacheTimestamp = Date.now();

// Clear cache when needed (called when project files change)
function clearProjectDirectoryCache() {
  projectDirectoryCache.clear();
  cacheTimestamp = Date.now();
}

// Load project configuration file
async function loadProjectConfig() {
  const configPath = path.join(getGeminiDir(), "project-config.json");
  try {
    const configData = await fs.readFile(configPath, "utf8");
    return JSON.parse(configData);
  } catch (error) {
    // Return empty config if file doesn't exist
    return {};
  }
}

// Save project configuration file
async function saveProjectConfig(config) {
  const configPath = path.join(getGeminiDir(), "project-config.json");
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
}

// Generate better display name from path
async function generateDisplayName(projectName, actualProjectDir = null) {
  // Use actual project directory if provided, otherwise decode from project name
  let projectPath = actualProjectDir || projectName.replace(/-/g, "/");

  // Try to read package.json from the project path
  try {
    const packageJsonPath = path.join(projectPath, "package.json");
    const packageData = await fs.readFile(packageJsonPath, "utf8");
    const packageJson = JSON.parse(packageData);

    // Return the name from package.json if it exists
    if (packageJson.name) {
      return packageJson.name;
    }
  } catch (error) {
    // Fall back to path-based naming if package.json doesn't exist or can't be read
  }

  // If it starts with /, it's an absolute path
  if (projectPath.startsWith("/")) {
    const parts = projectPath.split("/").filter(Boolean);
    if (parts.length > 3) {
      // Show last 2 folders with ellipsis: "...projects/myapp"
      return `.../${parts.slice(-2).join("/")}`;
    } else {
      // Show full path if short: "/home/user"
      return projectPath;
    }
  }

  return projectPath;
}

// Extract the actual project directory from JSONL sessions (with caching)
async function extractProjectDirectory(projectName) {
  // Check cache first
  if (projectDirectoryCache.has(projectName)) {
    return projectDirectoryCache.get(projectName);
  }

  const projectDir = path.join(getGeminiDir(), "projects", projectName);
  const cwdCounts = new Map();
  let latestTimestamp = 0;
  let latestCwd = null;
  let extractedPath;

  try {
    const files = await fs.readdir(projectDir);
    const jsonlFiles = files.filter((file) => file.endsWith(".jsonl"));

    if (jsonlFiles.length === 0) {
      // Fall back to decoded project name if no sessions
      // First try to decode from base64
      try {
        // Handle custom padding: __ at the end should be replaced with ==
        let base64Name = projectName.replace(/_/g, "+").replace(/-/g, "/");
        if (base64Name.endsWith("++")) {
          base64Name = base64Name.slice(0, -2) + "==";
        }
        extractedPath = Buffer.from(base64Name, "base64").toString("utf8");
        // Clean the path by removing any non-printable characters
        extractedPath = extractedPath.replace(/[^\x20-\x7E]/g, "").trim();
      } catch (e) {
        // If base64 decode fails, use old method
        extractedPath = projectName.replace(/-/g, "/");
      }
    } else {
      // Process all JSONL files to collect cwd values
      for (const file of jsonlFiles) {
        const jsonlFile = path.join(projectDir, file);
        const fileStream = fsSync.createReadStream(jsonlFile);
        const rl = readline.createInterface({
          input: fileStream,
          crlfDelay: Infinity,
        });

        for await (const line of rl) {
          if (line.trim()) {
            try {
              const entry = JSON.parse(line);

              if (entry.cwd) {
                // Count occurrences of each cwd
                cwdCounts.set(entry.cwd, (cwdCounts.get(entry.cwd) || 0) + 1);

                // Track the most recent cwd
                const timestamp = new Date(entry.timestamp || 0).getTime();
                if (timestamp > latestTimestamp) {
                  latestTimestamp = timestamp;
                  latestCwd = entry.cwd;
                }
              }
            } catch (parseError) {
              // Skip malformed lines
            }
          }
        }
      }

      // Determine the best cwd to use
      if (cwdCounts.size === 0) {
        // No cwd found, fall back to decoded project name
        extractedPath = projectName.replace(/-/g, "/");
      } else if (cwdCounts.size === 1) {
        // Only one cwd, use it
        extractedPath = Array.from(cwdCounts.keys())[0];
      } else {
        // Multiple cwd values - prefer the most recent one if it has reasonable usage
        const mostRecentCount = cwdCounts.get(latestCwd) || 0;
        const maxCount = Math.max(...cwdCounts.values());

        // Use most recent if it has at least 25% of the max count
        if (mostRecentCount >= maxCount * 0.25) {
          extractedPath = latestCwd;
        } else {
          // Otherwise use the most frequently used cwd
          for (const [cwd, count] of cwdCounts.entries()) {
            if (count === maxCount) {
              extractedPath = cwd;
              break;
            }
          }
        }

        // Fallback (shouldn't reach here)
        if (!extractedPath) {
          try {
            extractedPath =
              latestCwd ||
              Buffer.from(
                projectName.replace(/_/g, "+").replace(/-/g, "/"),
                "base64",
              ).toString("utf8");
          } catch (e) {
            extractedPath = latestCwd || projectName.replace(/-/g, "/");
          }
        }
      }
    }

    // Clean the extracted path by removing any non-printable characters
    extractedPath = extractedPath.replace(/[^\x20-\x7E]/g, "").trim();

    // Cache the result
    projectDirectoryCache.set(projectName, extractedPath);

    return extractedPath;
  } catch (error) {
    // console.error(`Error extracting project directory for ${projectName}:`, error);
    // Fall back to decoded project name
    try {
      // Handle custom padding: __ at the end should be replaced with ==
      let base64Name = projectName.replace(/_/g, "+").replace(/-/g, "/");
      if (base64Name.endsWith("++")) {
        base64Name = base64Name.slice(0, -2) + "==";
      }
      extractedPath = Buffer.from(base64Name, "base64").toString("utf8");
      // Clean the path by removing any non-printable characters
      extractedPath = extractedPath.replace(/[^\x20-\x7E]/g, "").trim();
    } catch (e) {
      extractedPath = projectName.replace(/-/g, "/");
    }

    // Cache the fallback result too
    projectDirectoryCache.set(projectName, extractedPath);

    return extractedPath;
  }
}

// Discover native Gemini CLI projects from the tmp directory
async function discoverNativeProjects() {
  const tmpDir = path.join(getGeminiDir(), "tmp");
  const nativeProjects = [];

  try {
    const entries = await fs.readdir(tmpDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.length === 64) {
        // This looks like a project hash folder (64 chars for SHA-256)
        const projectHashDir = path.join(tmpDir, entry.name);
        const chatsDir = path.join(projectHashDir, "chats");

        try {
          // Check if chats directory exists
          await fs.access(chatsDir);

          // Find the latest session file to extract the project path
          const sessionFiles = await fs.readdir(chatsDir);
          const latestSessionFile = sessionFiles
            .filter((f) => f.startsWith("session-") && f.endsWith(".json"))
            .sort()
            .reverse()[0];

          if (latestSessionFile) {
            const sessionPath = path.join(chatsDir, latestSessionFile);
            const sessionData = await fs.readFile(sessionPath, "utf8");
            const session = JSON.parse(sessionData);

            // Extract project path from metadata
            // Indigenous Gemini CLI sessions usually have 'cwd' or file paths in tool calls
            let projectPath = null;
            // Strategy 1: Check root properties
            if (session.cwd) {
              projectPath = session.cwd;
            }

            // Strategy 2: Scan all messages for absolute paths
            if (!projectPath && session.messages) {
              for (const msg of session.messages) {
                // Check all properties of the message for paths
                const searchTarget = JSON.stringify(msg);
                const pathMatch = searchTarget.match(
                  /(?:[A-Z]:\\|\/Users\/)[^\s",'\x1b\x07]+/i,
                );

                if (pathMatch) {
                  let foundPath = pathMatch[0].replace(/\\\\/g, "\\");
                  const parts = foundPath.split(/[\\\/]/).filter(Boolean);

                  // Extract root based on Joely's known structure: Users/joelj/source/repos/...
                  const reposIndex = parts.findIndex(
                    (p) => p.toLowerCase() === "repos",
                  );
                  if (reposIndex !== -1 && reposIndex + 2 < parts.length) {
                    // Reassemble from drive to project name folder
                    const drive = foundPath.match(/^[A-Z]:/i)
                      ? foundPath.substring(0, 2)
                      : "";
                    projectPath = parts.slice(0, reposIndex + 3).join(path.sep);
                    if (drive && !projectPath.startsWith(drive)) {
                      projectPath = drive + path.sep + projectPath;
                    }
                  }
                }
                if (projectPath) break;
              }
            }

            if (projectPath) {
              nativeProjects.push({
                hash: entry.name,
                path: projectPath,
                lastActivity: (await fs.stat(sessionPath)).mtime,
              });
            }
          }
        } catch (e) {
          // Skip if chats dir or session file is inaccessible
        }
      }
    }
  } catch (error) {
    // console.error('Error discovering native projects:', error);
  }

  return nativeProjects;
}

// Load projects from Gemini CLI's projects.json
async function loadCliProjects() {
  const projectsJsonPath = path.join(getGeminiDir(), "projects.json");
  try {
    const data = await fs.readFile(projectsJsonPath, "utf8");
    const { projects } = JSON.parse(data);
    return projects || {};
  } catch (error) {
    return {};
  }
}

async function getProjects() {
  const geminiDir = path.join(getGeminiDir(), "projects");
  const cliProjects = await loadCliProjects();
  const nativeProjects = await discoverNativeProjects();
  const config = await loadProjectConfig();
  const projects = [];
  const existingProjects = new Set();

  // Track projects we've already discovered via folder or json
  const discoveredPaths = new Set();

  try {
    // First, get existing projects from the file system
    const entries = await fs.readdir(geminiDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        existingProjects.add(entry.name);
        const projectPath = path.join(geminiDir, entry.name);

        // Extract actual project directory from JSONL sessions
        const actualProjectDir = await extractProjectDirectory(entry.name);

        // Get display name from config or generate one
        const customName = config[entry.name]?.displayName;
        const autoDisplayName = await generateDisplayName(
          entry.name,
          actualProjectDir,
        );
        const fullPath = actualProjectDir;

        const project = {
          name: entry.name,
          path: actualProjectDir,
          displayName: customName || autoDisplayName,
          fullPath: fullPath,
          isCustomName: !!customName,
          sessions: [],
        };

        // Try to get sessions for this project (just first 5 for performance)
        try {
          // Use sessionManager to get sessions for this project
          const sessionManager = (await import("./sessionManager.js")).default;
          const allSessions =
            sessionManager.getProjectSessions(actualProjectDir);

          // Paginate the sessions
          const paginatedSessions = allSessions.slice(0, 5);
          project.sessions = paginatedSessions;
          project.sessionMeta = {
            hasMore: allSessions.length > 5,
            total: allSessions.length,
          };
        } catch (e) {
          // console.warn(`Could not load sessions for project ${entry.name}:`, e.message);
        }

        projects.push(project);
      }
    }
  } catch (error) {
    // console.error('Error reading projects directory:', error);
  }

  // Add projects from projects.json that were not discovered via folder scan
  for (const [projectPath, projectName] of Object.entries(cliProjects)) {
    // Normalize path for comparison
    const normalizedPath = path.resolve(projectPath);

    // Check if we already have this project by path
    const alreadyExists = projects.some(
      (p) => path.resolve(p.path) === normalizedPath,
    );

    if (!alreadyExists) {
      // Find or generate a projectName-like ID
      // If the CLI provides a human name, that's "gemini-cli-ui" etc.
      // But the UI uses base64 encoded paths as internal IDs.
      const internalId = Buffer.from(normalizedPath)
        .toString("base64")
        .replace(/[/+=]/g, "_");

      const customName = config[internalId]?.displayName;
      const autoDisplayName = await generateDisplayName(
        internalId,
        normalizedPath,
      );

      projects.push({
        name: internalId,
        path: normalizedPath,
        displayName: projectName || customName || autoDisplayName,
        fullPath: normalizedPath,
        isCustomName: !!customName,
        sessions: [],
        sessionMeta: { total: 0, hasMore: false },
      });
      existingProjects.add(internalId);
    }
  }

  // Add native projects discovered via tmp hashes
  for (const nativeProj of nativeProjects) {
    const normalizedPath = path.resolve(nativeProj.path);
    const internalId = nativeProj.hash; // Use the native hash as the internal ID

    const alreadyExists = projects.some(
      (p) => path.resolve(p.path) === normalizedPath,
    );

    if (!alreadyExists) {
      const customName = config[internalId]?.displayName;
      const autoDisplayName = await generateDisplayName(
        internalId,
        normalizedPath,
      );

      const project = {
        name: internalId,
        path: normalizedPath,
        displayName: customName || autoDisplayName,
        fullPath: normalizedPath,
        isCustomName: !!customName,
        isNative: true,
        sessions: [],
        sessionMeta: { total: 0, hasMore: false },
      };

      // Try to get sessions for this native project
      try {
        const sessionsResult = await getSessions(internalId, 5, 0);
        project.sessions = sessionsResult.sessions;
        project.sessionMeta = {
          hasMore: sessionsResult.hasMore,
          total: sessionsResult.total,
        };
      } catch (e) {
        // console.warn(`Could not load sessions for native project ${internalId}:`, e.message);
      }

      projects.push(project);
      existingProjects.add(internalId);
    }
  }

  // Add manually configured projects that don't exist as folders yet
  for (const [projectName, projectConfig] of Object.entries(config)) {
    if (!existingProjects.has(projectName) && projectConfig.manuallyAdded) {
      // Use the original path if available, otherwise extract from potential sessions
      let actualProjectDir = projectConfig.originalPath;

      if (!actualProjectDir) {
        try {
          actualProjectDir = await extractProjectDirectory(projectName);
        } catch (error) {
          // Fall back to decoded project name
          actualProjectDir = projectName.replace(/-/g, "/");
        }
      }

      const project = {
        name: projectName,
        path: actualProjectDir,
        displayName:
          projectConfig.displayName ||
          (await generateDisplayName(projectName, actualProjectDir)),
        fullPath: actualProjectDir,
        isCustomName: !!projectConfig.displayName,
        isManuallyAdded: true,
        sessions: [],
      };

      projects.push(project);
    }
  }

  return projects;
}

async function getSessions(projectName, limit = 5, offset = 0) {
  // Always look in the projects directory for native-first discovery
  const projectDir = path.join(getGeminiDir(), "projects", projectName);

  try {
    const files = await fs.readdir(projectDir);
    const sessionFiles = files.filter((file) => file.endsWith(".jsonl"));

    if (sessionFiles.length === 0) {
      return { sessions: [], hasMore: false, total: 0 };
    }

    const allSessions = new Map();

    // Process all JSONL files to identify all unique sessionIds
    for (const file of sessionFiles) {
      const filePath = path.join(projectDir, file);
      const fileSessions = await parseJsonlSessions(filePath);
      
      fileSessions.forEach((session) => {
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

    // Convert to array and sort by last activity
    const sortedSessions = Array.from(allSessions.values()).sort(
      (a, b) => new Date(b.lastActivity) - new Date(a.lastActivity),
    );

    const total = sortedSessions.length;
    const paginatedSessions = sortedSessions.slice(offset, offset + limit);
    const hasMore = offset + limit < total;

    return {
      sessions: paginatedSessions,
      hasMore,
      total,
      offset,
      limit,
    };
  } catch (error) {
    // console.error(`Error reading sessions for project ${projectName}:`, error);
    return { sessions: [], hasMore: false, total: 0 };
  }
}

async function parseNativeSession(filePath) {
  try {
    const data = await fs.readFile(filePath, "utf8");
    const session = JSON.parse(data);

    if (!session.messages || session.messages.length === 0) return null;

    // Find first user message for summary
    const firstUserMsg = session.messages.find((m) => m.type === "user");
    const summary = firstUserMsg
      ? firstUserMsg.content.substring(0, 50) +
        (firstUserMsg.content.length > 50 ? "..." : "")
      : "Native Session";

    return {
      id: path.basename(filePath, ".json"),
      summary: summary,
      messageCount: session.messages.length,
      lastActivity: new Date((await fs.stat(filePath)).mtime),
      cwd: session.cwd || "",
      isNative: true,
    };
  } catch (error) {
    return null;
  }
}

async function parseJsonlSessions(filePath) {
  const sessions = new Map();

  try {
    const fileStream = fsSync.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    // Debug - [JSONL Parser] Reading file
    let lineCount = 0;

    for await (const line of rl) {
      if (line.trim()) {
        lineCount++;
        try {
          const entry = JSON.parse(line);

          if (entry.sessionId) {
            if (!sessions.has(entry.sessionId)) {
              sessions.set(entry.sessionId, {
                id: entry.sessionId,
                summary: "New Session",
                messageCount: 0,
                lastActivity: new Date(),
                cwd: entry.cwd || "",
              });
            }

            const session = sessions.get(entry.sessionId);

            // Update summary if this is a summary entry
            if (entry.type === "summary" && entry.summary) {
              session.summary = entry.summary;
            } else if (
              entry.message?.role === "user" &&
              entry.message?.content &&
              session.summary === "New Session"
            ) {
              // Use first user message as summary if no summary entry exists
              const content = entry.message.content;
              if (typeof content === "string" && content.length > 0) {
                // Skip command messages that start with <command-name>
                if (!content.startsWith("<command-name>")) {
                  session.summary =
                    content.length > 50
                      ? content.substring(0, 50) + "..."
                      : content;
                }
              }
            }

            // Count messages instead of storing them all
            session.messageCount = (session.messageCount || 0) + 1;

            // Update last activity
            if (entry.timestamp) {
              session.lastActivity = new Date(entry.timestamp);
            }
          }
        } catch (parseError) {
          // console.warn(`[JSONL Parser] Error parsing line ${lineCount}:`, parseError.message);
        }
      }
    }

    // Debug - [JSONL Parser] Processed lines and found sessions
  } catch (error) {
    // console.error('Error reading JSONL file:', error);
  }

  // Convert Map to Array and sort by last activity
  return Array.from(sessions.values()).sort(
    (a, b) => new Date(b.lastActivity) - new Date(a.lastActivity),
  );
}

// Get messages for a specific session
async function getSessionMessages(projectName, sessionId) {
  const isNative = projectName.length === 64;
  let projectDir;

  if (isNative) {
    projectDir = path.join(getGeminiDir(), "tmp", projectName, "chats");
    const sessionFile = path.join(projectDir, `${sessionId}.json`);
    try {
      const data = await fs.readFile(sessionFile, "utf8");
      const session = JSON.parse(data);
      return (session.messages || []).map((m) => ({
        sessionId: sessionId,
        type: m.type,
        message: {
          role: m.type,
          content: m.content,
        },
        timestamp: m.timestamp || new Date().toISOString(),
      }));
    } catch (e) {
      return [];
    }
  }

  projectDir = path.join(getGeminiDir(), "projects", projectName);

  try {
    const files = await fs.readdir(projectDir);
    const jsonlFiles = files.filter((file) => file.endsWith(".jsonl"));

    if (jsonlFiles.length === 0) {
      return [];
    }

    const messages = [];

    // Process all JSONL files to find messages for this session
    for (const file of jsonlFiles) {
      const jsonlFile = path.join(projectDir, file);
      const fileStream = fsSync.createReadStream(jsonlFile);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        if (line.trim()) {
          try {
            const entry = JSON.parse(line);
            if (entry.sessionId === sessionId) {
              messages.push(entry);
            }
          } catch (parseError) {
            // console.warn('Error parsing line:', parseError.message);
          }
        }
      }
    }

    // Sort messages by timestamp
    return messages.sort(
      (a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0),
    );
  } catch (error) {
    // console.error(`Error reading messages for session ${sessionId}:`, error);
    return [];
  }
}

// Rename a project's display name
async function renameProject(projectName, newDisplayName) {
  const config = await loadProjectConfig();

  if (!newDisplayName || newDisplayName.trim() === "") {
    // Remove custom name if empty, will fall back to auto-generated
    delete config[projectName];
  } else {
    // Set custom display name
    config[projectName] = {
      displayName: newDisplayName.trim(),
    };
  }

  await saveProjectConfig(config);
  return true;
}

// Delete a session from a project
async function deleteSession(projectName, sessionId) {
  const projectDir = path.join(getGeminiDir(), "projects", projectName);

  try {
    const files = await fs.readdir(projectDir);
    const jsonlFiles = files.filter((file) => file.endsWith(".jsonl"));

    if (jsonlFiles.length === 0) {
      throw new Error("No session files found for this project");
    }

    // Check all JSONL files to find which one contains the session
    for (const file of jsonlFiles) {
      const jsonlFile = path.join(projectDir, file);
      const content = await fs.readFile(jsonlFile, "utf8");
      const lines = content.split("\n").filter((line) => line.trim());

      // Check if this file contains the session
      const hasSession = lines.some((line) => {
        try {
          const data = JSON.parse(line);
          return data.sessionId === sessionId;
        } catch {
          return false;
        }
      });

      if (hasSession) {
        // Filter out all entries for this session
        const filteredLines = lines.filter((line) => {
          try {
            const data = JSON.parse(line);
            return data.sessionId !== sessionId;
          } catch {
            return true; // Keep malformed lines
          }
        });

        // Write back the filtered content
        await fs.writeFile(
          jsonlFile,
          filteredLines.join("\n") + (filteredLines.length > 0 ? "\n" : ""),
        );
        return true;
      }
    }

    throw new Error(`Session ${sessionId} not found in any files`);
  } catch (error) {
    // console.error(`Error deleting session ${sessionId} from project ${projectName}:`, error);
    throw error;
  }
}

// Check if a project is empty (has no sessions)
async function isProjectEmpty(projectName) {
  try {
    const sessionsResult = await getSessions(projectName, 1, 0);
    return sessionsResult.total === 0;
  } catch (error) {
    // console.error(`Error checking if project ${projectName} is empty:`, error);
    return false;
  }
}

// Delete an empty project
async function deleteProject(projectName) {
  const projectDir = path.join(getGeminiDir(), "projects", projectName);

  try {
    // First check if the project is empty
    const isEmpty = await isProjectEmpty(projectName);
    if (!isEmpty) {
      throw new Error("Cannot delete project with existing sessions");
    }

    // Remove the project directory
    await fs.rm(projectDir, { recursive: true, force: true });

    // Remove from project config
    const config = await loadProjectConfig();
    delete config[projectName];
    await saveProjectConfig(config);

    return true;
  } catch (error) {
    // console.error(`Error deleting project ${projectName}:`, error);
    throw error;
  }
}

// Add a project manually to the config (create folder if needed)
async function addProjectManually(projectPath, displayName = null) {
  const absolutePath = path.resolve(projectPath);

  try {
    // Check if the path exists
    await fs.access(absolutePath);
  } catch (error) {
    // If path doesn't exist, try to create it
    if (error.code === "ENOENT") {
      try {
        await fs.mkdir(absolutePath, { recursive: true });
        console.log(`Created new directory: ${absolutePath}`);
      } catch (mkdirError) {
        throw new Error(
          `Failed to create directory: ${absolutePath} - ${mkdirError.message}`,
        );
      }
    } else {
      throw new Error(`Cannot access path: ${absolutePath} - ${error.message}`);
    }
  }

  // Generate project name (encode path for use as directory name)
  // Use base64 encoding to handle all path characters safely
  const projectName = Buffer.from(absolutePath)
    .toString("base64")
    .replace(/[/+=]/g, "_");

  // Check if project already exists in config or as a folder
  const config = await loadProjectConfig();
  const projectDir = path.join(getGeminiDir(), "projects", projectName);

  try {
    await fs.access(projectDir);
    throw new Error(`Project already exists for path: ${absolutePath}`);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  if (config[projectName]) {
    throw new Error(`Project already configured for path: ${absolutePath}`);
  }

  // Add to config as manually added project
  config[projectName] = {
    manuallyAdded: true,
    originalPath: absolutePath,
  };

  if (displayName) {
    config[projectName].displayName = displayName;
  }

  await saveProjectConfig(config);

  // Create the project directory
  try {
    await fs.mkdir(projectDir, { recursive: true });
  } catch (error) {
    // console.error('Error creating project directory:', error);
  }

  return {
    name: projectName,
    path: absolutePath,
    fullPath: absolutePath,
    displayName:
      displayName || (await generateDisplayName(projectName, absolutePath)),
    isManuallyAdded: true,
    sessions: [],
  };
}

export {
  getProjects,
  getSessions,
  getSessionMessages,
  parseJsonlSessions,
  renameProject,
  deleteSession,
  isProjectEmpty,
  deleteProject,
  addProjectManually,
  loadProjectConfig,
  saveProjectConfig,
  extractProjectDirectory,
  clearProjectDirectoryCache,
};
