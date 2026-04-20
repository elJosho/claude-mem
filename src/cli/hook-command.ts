import { readJsonFromStdin } from './stdin-reader.js';
import { getPlatformAdapter } from './adapters/index.js';
import { getEventHandler } from './handlers/index.js';
import { HOOK_EXIT_CODES } from '../shared/hook-constants.js';
import { logger } from '../utils/logger.js';
import { OBSERVER_SESSIONS_DIR } from '../shared/paths.js';

export interface HookCommandOptions {
  /** If true, don't call process.exit() - let caller handle process lifecycle */
  skipExit?: boolean;
}

/**
 * Classify whether an error indicates the worker is unavailable (graceful degradation)
 * vs a handler/client bug (blocking error that developers need to see).
 *
 * Exit 0 (graceful degradation):
 * - Transport failures: ECONNREFUSED, ECONNRESET, EPIPE, ETIMEDOUT, fetch failed
 * - Timeout errors: timed out, timeout
 * - Server errors: HTTP 5xx status codes
 *
 * Exit 2 (blocking error — handler/client bug):
 * - HTTP 4xx status codes (bad request, not found, validation error)
 * - Programming errors (TypeError, ReferenceError, SyntaxError)
 * - All other unexpected errors
 */
export function isWorkerUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  // Transport failures — worker unreachable
  const transportPatterns = [
    'econnrefused',
    'econnreset',
    'epipe',
    'etimedout',
    'enotfound',
    'econnaborted',
    'enetunreach',
    'ehostunreach',
    'fetch failed',
    'unable to connect',
    'socket hang up',
  ];
  if (transportPatterns.some(p => lower.includes(p))) return true;

  // Timeout errors — worker didn't respond in time
  if (lower.includes('timed out') || lower.includes('timeout')) return true;

  // HTTP 5xx server errors — worker has internal problems
  if (/failed:\s*5\d{2}/.test(message) || /status[:\s]+5\d{2}/.test(message)) return true;

  // HTTP 429 (rate limit) — treat as transient unavailability, not a bug
  if (/failed:\s*429/.test(message) || /status[:\s]+429/.test(message)) return true;

  // HTTP 4xx client errors — our bug, NOT worker unavailability
  if (/failed:\s*4\d{2}/.test(message) || /status[:\s]+4\d{2}/.test(message)) return false;

  // Programming errors — code bugs, not worker unavailability
  // Note: TypeError('fetch failed') already handled by transport patterns above
  if (error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError) {
    return false;
  }

  // Default: treat unknown errors as blocking (conservative — surface bugs)
  return false;
}

export async function hookCommand(platform: string, event: string, options: HookCommandOptions = {}): Promise<number> {
  // Suppress stderr in hook context — Claude Code shows stderr as error UI (#1181)
  // Exit 1: stderr shown to user. Exit 2: stderr fed to Claude for processing.
  // All diagnostics go to log file via logger; stderr must stay clean.
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;

  try {
    const adapter = getPlatformAdapter(platform);
    const handler = getEventHandler(event);

    const rawInput = await readJsonFromStdin();
    const input = adapter.normalizeInput(rawInput);
    input.platform = platform;  // Inject platform for handler-level decisions

    // Guard: never process hooks fired from observer-session subprocesses.
    // The SDKAgent spawns Claude CLI in OBSERVER_SESSIONS_DIR, which triggers
    // global hooks — storing its system prompts and tool calls as user data.
    logger.debug('HOOK', `CWD guard check: event=${event} input.cwd=${input.cwd} OBSERVER_DIR=${OBSERVER_SESSIONS_DIR} match=${input.cwd?.startsWith(OBSERVER_SESSIONS_DIR)}`);
    if (input.cwd && input.cwd.startsWith(OBSERVER_SESSIONS_DIR)) {
      logger.debug('HOOK', `Skipping hook for observer-session subprocess: ${event}`, { cwd: input.cwd });
      console.log(JSON.stringify(adapter.formatOutput({ continue: true, suppressOutput: true })));
      if (!options.skipExit) {
        process.exit(HOOK_EXIT_CODES.SUCCESS);
      }
      return HOOK_EXIT_CODES.SUCCESS;
    }

    const result = await handler.execute(input);
    const output = adapter.formatOutput(result);

    console.log(JSON.stringify(output));
    const exitCode = result.exitCode ?? HOOK_EXIT_CODES.SUCCESS;
    if (!options.skipExit) {
      process.exit(exitCode);
    }
    return exitCode;
  } catch (error) {
    if (isWorkerUnavailableError(error)) {
      // Worker unavailable — degrade gracefully, don't block the user
      // Log to file instead of stderr (#1181)
      logger.warn('HOOK', `Worker unavailable, skipping hook: ${error instanceof Error ? error.message : error}`);
      if (!options.skipExit) {
        process.exit(HOOK_EXIT_CODES.SUCCESS);  // = 0 (graceful)
      }
      return HOOK_EXIT_CODES.SUCCESS;
    }

    // Handler/client bug — log to file instead of stderr (#1181)
    logger.error('HOOK', `Hook error: ${error instanceof Error ? error.message : error}`, {}, error instanceof Error ? error : undefined);
    if (!options.skipExit) {
      process.exit(HOOK_EXIT_CODES.BLOCKING_ERROR);  // = 2
    }
    return HOOK_EXIT_CODES.BLOCKING_ERROR;
  } finally {
    // Restore stderr for non-hook code paths (e.g., when skipExit is true and process continues as worker)
    process.stderr.write = originalStderrWrite;
  }
}
