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
const MAX_USER_PROMPT_LENGTH = 2000;

/**
 * Minimum character length for a message to be considered a potential skill prompt.
 * Real user prompts are almost never this long as a single message.
 */
const SKILL_PROMPT_MIN_LENGTH = 500;

// Tag constants for AGENTS.md context injection (must match context-injection.ts)
const CONTEXT_TAG_OPEN = "<claude-mem-context>";
const CONTEXT_TAG_CLOSE = "</claude-mem-context>";

// ============================================================================
// Skill Prompt Detection & Stripping
// ============================================================================

/**
 * Detect and strip skill preamble from user messages.
 *
 * When OpenCode loads a skill (e.g. /datalake), it prepends the entire SKILL.md
 * content to the first user message. The user's actual query is appended at the
 * end after the skill instructions. This function detects skill-like preamble
 * and extracts only the user's real prompt.
 *
 * Detection heuristics (all must be true):
 * - Message is longer than SKILL_PROMPT_MIN_LENGTH chars
 * - Starts with a markdown heading (# )
 * - Contains instructional patterns (## sections, code blocks, tables)
 *
 * If detected, we try to extract the user's query from the end. The skill
 * content typically ends with a section like "## Notes" or similar, and the
 * user's query follows with no heading prefix.
 *
 * Returns the cleaned prompt (user query only) or null if the entire message
 * appears to be skill content with no user query.
 */
function stripSkillPreamble(text: string): string | null {
  if (text.length < SKILL_PROMPT_MIN_LENGTH) return text;
  if (!text.startsWith("# ")) return text;

  // Check for instructional markdown patterns that indicate skill content
  const hasMultipleSections = (text.match(/^#{1,3} /gm) || []).length >= 3;
  const hasCodeBlocks = text.includes("```");
  const hasTables = text.includes("| ") && text.includes("|---|");

  // Must have at least 2 of these 3 structural indicators
  const structuralIndicators = [hasMultipleSections, hasCodeBlocks, hasTables].filter(Boolean).length;
  if (structuralIndicators < 2) return text;

  // This looks like a skill prompt. Try to extract the user's actual query
  // from the end. The user's query is typically the last paragraph after all
  // the markdown sections.
  //
  // Strategy: Find the last markdown section header, then look for content
  // after the section that doesn't look like skill instructions.
  const lines = text.split("\n");

  // Walk backwards from the end to find where the user's query starts.
  // The user query is typically a short line at the end, separated from
  // the skill content by a blank line or just appended directly.
  let lastSectionEnd = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("#") || lines[i].startsWith("```") || lines[i].startsWith("| ") || lines[i].startsWith("- ")) {
      lastSectionEnd = i;
      break;
    }
  }

  if (lastSectionEnd >= 0 && lastSectionEnd < lines.length - 1) {
    // Extract everything after the last structural line
    const userQuery = lines
      .slice(lastSectionEnd + 1)
      .join("\n")
      .trim();
    if (userQuery.length > 0) {
      return userQuery;
    }
  }

  // No user query found after skill content — skip this prompt entirely
  return null;
}

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
      `/api/context/inject?projects=${encodeURIComponent(projectName)}`,
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
/** Accumulates text parts per part ID from message.part.updated events */
const messageTextParts = new Map<string, string>();
/** Maps messageID → role from message.updated events */
const messageRoles = new Map<string, string>();

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

  // ------------------------------------------------------------------
  // Helper: Collect text from accumulated parts for a given messageID.
  // Parts are keyed by part.id in messageTextParts.  We match by checking
  // which part IDs belong to a given messageID via a naming convention or
  // by scanning.  Since message.part.updated gives us part.messageID, we
  // need a reverse index.
  // ------------------------------------------------------------------

  /** Maps partId → messageID so we can collect all parts for a message */
  const partToMessage = new Map<string, string>();
  /** Tracks assistant messages we've already sent as observations */
  const assistantMessagesSent = new Set<string>();

  function collectTextForMessage(messageId: string): string {
    const texts: string[] = [];
    for (const [partId, msgId] of partToMessage) {
      if (msgId === messageId) {
        const text = messageTextParts.get(partId);
        if (text) texts.push(text);
      }
    }
    return texts.join("\n");
  }

  /**
   * Handles text for a message once we know its role and have parts.
   * For user messages: sends session init with the actual prompt text.
   * For assistant messages: sends observation with the response text.
   * 
   * calledFrom indicates whether this was triggered by a part update or
   * a message update.  Assistant observations are only sent from
   * message.updated (which fires once when the message is finalized)
   * to avoid flooding during streaming part updates.
   */
  async function handleMessageText(
    ocSessionId: string,
    messageId: string,
    role: string,
    _ctx: OpenCodePluginContext,
    _projectName: string,
    calledFrom: "part" | "message" = "message",
  ): Promise<void> {
    const contentSessionId = getOrCreateContentSessionId(ocSessionId);
    const messageText = collectTextForMessage(messageId);

    if (role === "user") {
      if (!messageText || sessionPromptSent.has(ocSessionId)) return;
      sessionPromptSent.add(ocSessionId);

      // Strip skill preamble — when a skill is loaded, OpenCode prepends the
      // entire SKILL.md content to the first user message.  We extract only
      // the user's actual query.
      const cleanedPrompt = stripSkillPreamble(messageText);
      if (!cleanedPrompt) {
        // Entire message was skill content with no user query — still init
        // the session but with a marker so the worker knows it's skill-only
        await workerPost("/api/sessions/init", {
          contentSessionId,
          project: _projectName,
          prompt: "[skill invocation]",
          platformSource: "opencode",
        });
        return;
      }

      // Truncate excessively long prompts (e.g. pasted log dumps, table output)
      // to prevent storing megabytes of non-semantic data as user prompts.
      const cappedPrompt = cleanedPrompt.length > MAX_USER_PROMPT_LENGTH
        ? cleanedPrompt.slice(0, MAX_USER_PROMPT_LENGTH) + "..."
        : cleanedPrompt;

      await workerPost("/api/sessions/init", {
        contentSessionId,
        project: _projectName,
        prompt: cappedPrompt,
        platformSource: "opencode",
      });
      return;
    }

    // Only send assistant observations from message.updated to avoid
    // flooding during streaming.  message.updated fires each time the
    // message object changes (including when finish reason is set).
    if (role === "assistant" && calledFrom === "message") {
      if (assistantMessagesSent.has(messageId)) return;
      let text = messageText;
      if (!text) return;
      assistantMessagesSent.add(messageId);
      if (text.length > MAX_TOOL_RESPONSE_LENGTH) {
        text = text.slice(0, MAX_TOOL_RESPONSE_LENGTH);
      }
      await workerPost("/api/sessions/observations", {
        contentSessionId,
        tool_name: "assistant_message",
        tool_input: {},
        tool_response: text,
        cwd: _ctx.directory,
        platformSource: "opencode",
      });
    }
  }

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

        // ------------------------------------------------------------------
        // message.part.updated: Fires for each part of a message.
        // OpenCode delivers parts separately — NOT inside message.updated.
        // We accumulate text parts here and use them for session init and
        // assistant message observations.
        // ------------------------------------------------------------------
        case "message.part.updated": {
          const props = event.properties as {
            part: { id: string; sessionID: string; messageID: string; type: string; text?: string };
            delta?: string;
          };
          const part = props.part;
          if (part.type !== "text" || !part.text) break;

          // Accumulate/replace text for this part (parts update in-place)
          messageTextParts.set(part.id, part.text);
          partToMessage.set(part.id, part.messageID);

          // Check if we know the role for this message yet
          const role = messageRoles.get(part.messageID);
          if (role) {
            await handleMessageText(part.sessionID, part.messageID, role, ctx, projectName, "part");
          }
          break;
        }

        case "message.updated": {
          const props = event.properties as { info: { id: string; sessionID: string; role: string } };
          const msgId = props.info.id;
          const ocSessionId = props.info.sessionID;
          const role = props.info.role;

          // Record the role so message.part.updated can use it
          messageRoles.set(msgId, role);

          // If parts already arrived before this event, process now
          await handleMessageText(ocSessionId, msgId, role, ctx, projectName);
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
            `/api/search?query=${encodeURIComponent(query)}&limit=10&format=json`,
          );

          if (!text) {
            return "claude-mem worker is not running. Start it with: npx claude-mem start";
          }

          try {
            const data = JSON.parse(text);
            const items = Array.isArray(data.observations) ? data.observations : [];
            if (items.length === 0) {
              return `No results found for "${query}".`;
            }

            return items
              .slice(0, 10)
              .map((item: Record<string, unknown>, index: number) => {
                const title = String(item.title || item.subtitle || "Untitled");
                const project = item.project ? ` [${String(item.project)}]` : "";
                const subtitle = item.subtitle ? `\n   ${String(item.subtitle)}` : "";
                return `${index + 1}. [#${item.id}] ${title}${project}${subtitle}`;
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
