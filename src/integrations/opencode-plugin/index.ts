/**
 * OpenCode Plugin for claude-mem
 *
 * Integrates claude-mem persistent memory with OpenCode (110k+ stars).
 * Runs inside OpenCode's Bun-based plugin runtime.
 *
 * Plugin hooks:
 * - tool.execute.after: Captures tool execution observations
 * - Bus events: session.created, message.updated, session.compacted,
 *   file.edited, session.deleted
 *
 * Custom tool:
 * - claude_mem_search: Search memory database from within OpenCode
 */

import { tool } from "@opencode-ai/plugin";

// ============================================================================
// Minimal type declarations for OpenCode Plugin SDK (1.4.0 API)
// These match the runtime API provided by @opencode-ai/plugin
// ============================================================================

interface OpenCodeProject {
  id?: string;
  path?: string;
}

interface OpenCodePluginContext {
  client: unknown;
  project: OpenCodeProject;
  directory: string;
  worktree: string;
  serverUrl: URL;
  $: unknown; // BunShell
}

interface ToolContext {
  sessionID: string;
  messageID: string;
  agent: string;
  directory: string;
  worktree: string;
  abort: AbortSignal;
}

// OpenCode 1.4.0 Event types (Event union with { type, properties })
interface OCEvent {
  type: string;
  properties: Record<string, unknown>;
}

// ============================================================================
// Constants
// ============================================================================

const WORKER_BASE_URL = "http://127.0.0.1:37777";
const MAX_TOOL_RESPONSE_LENGTH = 1000;

// Tag constants for AGENTS.md context injection (must match context-injection.ts)
const CONTEXT_TAG_OPEN = "<claude-mem-context>";
const CONTEXT_TAG_CLOSE = "</claude-mem-context>";

// ============================================================================
// Worker HTTP Client
// ============================================================================

async function workerPost(
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`${WORKER_BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.warn(`[claude-mem] Worker POST ${path} returned ${response.status}`);
      return null;
    }
    return (await response.json()) as Record<string, unknown>;
  } catch (error: unknown) {
    // Gracefully handle ECONNREFUSED — worker may not be running
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ECONNREFUSED")) {
      console.warn(`[claude-mem] Worker POST ${path} failed: ${message}`);
    }
    return null;
  }
}


async function workerGetText(path: string): Promise<string | null> {
  try {
    const response = await fetch(`${WORKER_BASE_URL}${path}`);
    if (!response.ok) {
      console.warn(`[claude-mem] Worker GET ${path} returned ${response.status}`);
      return null;
    }
    return await response.text();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ECONNREFUSED")) {
      console.warn(`[claude-mem] Worker GET ${path} failed: ${message}`);
    }
    return null;
  }
}

// ============================================================================
// AGENTS.md Context Refresh
// ============================================================================

/**
 * Resolve the AGENTS.md path for context injection.
 * Respects OPENCODE_CONFIG_DIR env var, falls back to ~/.config/opencode.
 */
function getAgentsMdPath(): string {
  const { homedir } = require("os");
  const { join } = require("path");
  const configDir = process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode");
  return join(configDir, "AGENTS.md");
}

/**
 * Inject context content into AGENTS.md, replacing existing tagged section
 * or appending if no tags exist. Creates the file if needed.
 */
function writeContextToAgentsMd(contextContent: string): void {
  const { existsSync, readFileSync, writeFileSync, mkdirSync } = require("fs");
  const { dirname } = require("path");

  const filePath = getAgentsMdPath();
  const parentDir = dirname(filePath);
  mkdirSync(parentDir, { recursive: true });

  const wrappedContent = `${CONTEXT_TAG_OPEN}\n${contextContent}\n${CONTEXT_TAG_CLOSE}`;
  const header = "# Claude-Mem Memory Context";

  if (existsSync(filePath)) {
    let existing: string = readFileSync(filePath, "utf-8");
    const tagStart = existing.indexOf(CONTEXT_TAG_OPEN);
    const tagEnd = existing.indexOf(CONTEXT_TAG_CLOSE);

    if (tagStart !== -1 && tagEnd !== -1) {
      existing =
        existing.slice(0, tagStart) +
        wrappedContent +
        existing.slice(tagEnd + CONTEXT_TAG_CLOSE.length);
    } else {
      existing = existing.trimEnd() + "\n\n" + wrappedContent + "\n";
    }
    writeFileSync(filePath, existing, "utf-8");
  } else {
    writeFileSync(filePath, `${header}\n\n${wrappedContent}\n`, "utf-8");
  }
}

/**
 * Fetch fresh context from the worker and write it to AGENTS.md.
 * Non-blocking — errors are silently ignored so plugin flow is never disrupted.
 */
async function refreshAgentsMdContext(projectName: string): Promise<void> {
  try {
    const contextText = await workerGetText(
      `/api/context/inject?projects=${encodeURIComponent(projectName)}&platformSource=opencode`,
    );
    if (contextText && contextText.trim()) {
      writeContextToAgentsMd(contextText);
    }
  } catch {
    // Non-critical — worker may not be available
  }
}

// ============================================================================
// Session tracking
// ============================================================================

const contentSessionIdsByOpenCodeSessionId = new Map<string, string>();
/** Tracks whether we've already sent a real user prompt for a given OpenCode session */
const sessionPromptSent = new Set<string>();

const MAX_SESSION_MAP_ENTRIES = 1000;

function getOrCreateContentSessionId(openCodeSessionId: string): string {
  if (!contentSessionIdsByOpenCodeSessionId.has(openCodeSessionId)) {
    // Evict oldest entries when the map exceeds the cap (Map preserves insertion order)
    while (contentSessionIdsByOpenCodeSessionId.size >= MAX_SESSION_MAP_ENTRIES) {
      const oldestKey = contentSessionIdsByOpenCodeSessionId.keys().next().value;
      if (oldestKey !== undefined) {
        contentSessionIdsByOpenCodeSessionId.delete(oldestKey);
      } else {
        break;
      }
    }
    contentSessionIdsByOpenCodeSessionId.set(
      openCodeSessionId,
      `opencode-${openCodeSessionId}-${Date.now()}`,
    );
  }
  return contentSessionIdsByOpenCodeSessionId.get(openCodeSessionId)!;
}

// ============================================================================
// Plugin Entry Point
// ============================================================================

export const ClaudeMemPlugin = async (ctx: OpenCodePluginContext) => {
  // Derive project name from directory path (consistent with Claude Code/Cursor adapters)
  // ctx.project.id is a hash, not a human-readable name
  const projectName = ctx.directory
    ? (ctx.directory.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || "opencode")
    : "opencode";

  console.log(`[claude-mem] OpenCode plugin loading (project: ${projectName})`);

  return {
    // ------------------------------------------------------------------
    // Tool execution hook (1.4.0 flat key)
    // ------------------------------------------------------------------
    "tool.execute.after": async (
      input: { tool: string; sessionID: string; callID: string; args: Record<string, unknown> },
      output: { title: string; output: string; metadata: Record<string, unknown> },
    ): Promise<void> => {
      const contentSessionId = getOrCreateContentSessionId(input.sessionID);

      let toolResponseText = output.output || "";
      if (toolResponseText.length > MAX_TOOL_RESPONSE_LENGTH) {
        toolResponseText = toolResponseText.slice(0, MAX_TOOL_RESPONSE_LENGTH);
      }

      await workerPost("/api/sessions/observations", {
        contentSessionId,
        tool_name: input.tool,
        tool_input: input.args || {},
        tool_response: toolResponseText,
        cwd: ctx.directory,
        platformSource: "opencode",
      });
    },

    // ------------------------------------------------------------------
    // Bus event handlers (1.4.0: single { event } arg with type+properties)
    // ------------------------------------------------------------------
    event: async ({ event }: { event: OCEvent }): Promise<void> => {
      switch (event.type) {
        case "session.created": {
          const props = event.properties as { info: { id: string } };
          // Pre-allocate the contentSessionId so subsequent events use the same one
          getOrCreateContentSessionId(props.info.id);

          // Do NOT send /api/sessions/init here — the prompt is not available yet.
          // Init is deferred to message.updated when we have the user's actual prompt.
          // Sending an empty prompt causes the worker to substitute '[media prompt]'.

          // Refresh AGENTS.md with latest context so the new session starts with memory
          await refreshAgentsMdContext(projectName);
          break;
        }

        case "message.updated": {
          const props = event.properties as { info: { sessionID: string; role: string; parts?: Array<{ type: string; text?: string }> } };
          const ocSessionId = props.info.sessionID;
          const contentSessionId = getOrCreateContentSessionId(ocSessionId);

          // Extract text from parts array
          const parts = props.info.parts || [];
          let messageText = parts
            .filter((p) => p.type === "text" && p.text)
            .map((p) => p.text || "")
            .join("\n");

          // Capture user messages as session prompts.
          // Init is deferred from session.created to here so we always have
          // the actual user prompt text rather than sending an empty string
          // (which the worker substitutes as '[media prompt]').
          if (props.info.role === "user") {
            if (!sessionPromptSent.has(ocSessionId)) {
              sessionPromptSent.add(ocSessionId);
              await workerPost("/api/sessions/init", {
                contentSessionId,
                project: projectName,
                prompt: messageText || "(media/image prompt)",
                platformSource: "opencode",
              });
            }
            break;
          }

          // Only capture assistant messages as observations
          if (props.info.role !== "assistant") break;

          if (messageText.length > MAX_TOOL_RESPONSE_LENGTH) {
            messageText = messageText.slice(0, MAX_TOOL_RESPONSE_LENGTH);
          }
          if (!messageText) break;

          await workerPost("/api/sessions/observations", {
            contentSessionId,
            tool_name: "assistant_message",
            tool_input: {},
            tool_response: messageText,
            cwd: ctx.directory,
            platformSource: "opencode",
          });
          break;
        }

        case "session.compacted": {
          const props = event.properties as { sessionID: string };
          const contentSessionId = getOrCreateContentSessionId(props.sessionID);

          await workerPost("/api/sessions/summarize", {
            contentSessionId,
            last_assistant_message: "",
            platformSource: "opencode",
          });
          break;
        }

        case "file.edited": {
          const props = event.properties as { file: string };
          // file.edited doesn't include a sessionID in 1.4.0 — skip for now
          // We rely on tool.execute.after for file edit observations instead
          void props;
          break;
        }

        case "session.deleted": {
          const props = event.properties as { info: { id: string } };
          const contentSessionId = contentSessionIdsByOpenCodeSessionId.get(props.info.id);

          if (contentSessionId) {
            await workerPost("/api/sessions/complete", {
              contentSessionId,
              platformSource: "opencode",
            });
            contentSessionIdsByOpenCodeSessionId.delete(props.info.id);
            sessionPromptSent.delete(props.info.id);
          }

          // Refresh AGENTS.md so the next session picks up this session's observations
          await refreshAgentsMdContext(projectName);
          break;
        }
      }
    },

    // ------------------------------------------------------------------
    // Custom tools
    // ------------------------------------------------------------------
    tool: {
      claude_mem_search: tool({
        description:
          "Search claude-mem memory database for past observations, sessions, and context",
        args: {
          query: tool.schema.string().describe("Search query for memory observations"),
        },
        async execute(
          args: { query: string },
          _context: ToolContext,
        ): Promise<string> {
          const query = args.query || "";
          if (!query) {
            return "Please provide a search query.";
          }

          const text = await workerGetText(
            `/api/search/observations?query=${encodeURIComponent(query)}&limit=10`,
          );

          if (!text) {
            return "claude-mem worker is not running. Start it with: npx claude-mem start";
          }

          try {
            const data = JSON.parse(text);
            const items = Array.isArray(data.items) ? data.items : [];
            if (items.length === 0) {
              return `No results found for "${query}".`;
            }

            return items
              .slice(0, 10)
              .map((item: Record<string, unknown>, index: number) => {
                const title = String(item.title || item.subtitle || "Untitled");
                const project = item.project ? ` [${String(item.project)}]` : "";
                return `${index + 1}. ${title}${project}`;
              })
              .join("\n");
          } catch {
            return "Failed to parse search results.";
          }
        },
      }),
    },
  };
};

// OpenCode 1.3+ expects PluginModule shape: { server: Plugin }
export default {
  id: 'claude-mem',
  server: ClaudeMemPlugin,
};
