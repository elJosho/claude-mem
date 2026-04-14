/**
 * BedrockAgent: AWS Bedrock-based observation extraction
 *
 * Alternative to SDKAgent that uses AWS Bedrock's InvokeModel API
 * for extracting observations from tool usage. Supports Claude models
 * on Bedrock with AWS SigV4 authentication (no AWS SDK dependency).
 *
 * Responsibility:
 * - Call Bedrock InvokeModel API with Anthropic Messages format
 * - Sign requests with AWS SigV4 (inline implementation)
 * - Parse XML responses (same format as Claude/Gemini)
 * - Sync to database and Chroma
 */

import { createHmac, createHash } from 'crypto';
import { homedir } from 'os';
import path from 'path';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt, buildContinuationPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { estimateTokens } from '../../shared/timeline-formatting.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import {
  processAgentResponse,
  shouldFallbackToClaude,
  isAbortError,
  type WorkerRef,
  type FallbackAgent
} from './agents/index.js';

// Context window limits (prevents O(N^2) token cost growth)
const DEFAULT_MAX_CONTEXT_MESSAGES = 20;
const DEFAULT_MAX_ESTIMATED_TOKENS = 100000;

// Portable tier aliases mapped to Bedrock model IDs
const TIER_ALIASES: Record<string, string> = {
  'haiku': 'anthropic.claude-3-5-haiku-20241022-v1:0',
  'sonnet': 'us.anthropic.claude-sonnet-4-6-v1',
  'opus': 'us.anthropic.claude-opus-4-6-v1',
};

// ============================================================================
// AWS SigV4 Signing (inline — avoids @aws-sdk dependency)
// ============================================================================

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function getSigningKey(secretKey: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmacSha256(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

/**
 * URI-encode a path for SigV4 canonical request.
 * Encodes all characters except unreserved (A-Za-z0-9-._~) and '/'.
 */
function uriEncodePath(pathStr: string): string {
  return encodeURIComponent(pathStr).replace(/%2F/g, '/');
}

interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
}

/**
 * Sign an HTTP request using AWS SigV4.
 * Returns headers object including Authorization, x-amz-date, etc.
 */
function signRequest(
  method: string,
  url: URL,
  body: string,
  credentials: AwsCredentials,
  service: string = 'bedrock'
): Record<string, string> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = sha256Hex(body);

  // Build headers to sign
  const headers: Record<string, string> = {
    'host': url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    'content-type': 'application/json',
    'accept': 'application/json',
  };

  if (credentials.sessionToken) {
    headers['x-amz-security-token'] = credentials.sessionToken;
  }

  // Canonical headers: sorted by lowercase key, trimmed values
  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map(k => `${k}:${headers[k].trim()}`).join('\n') + '\n';
  const signedHeaders = sortedKeys.join(';');

  // Canonical URI: URI-encode path segments (non-S3)
  const canonicalUri = uriEncodePath(url.pathname);

  // Canonical query string (empty for POST)
  const canonicalQueryString = '';

  // Build canonical request
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  // String to sign
  const credentialScope = `${dateStamp}/${credentials.region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join('\n');

  // Calculate signature
  const signingKey = getSigningKey(credentials.secretAccessKey, dateStamp, credentials.region, service);
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  // Build Authorization header
  const authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    ...headers,
    'Authorization': authorization,
  };
}

// ============================================================================
// Bedrock API Types
// ============================================================================

interface BedrockMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface BedrockResponse {
  id?: string;
  type?: string;
  role?: string;
  content?: Array<{ type: string; text?: string }>;
  model?: string;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

interface BedrockConfig {
  credentials: AwsCredentials;
  model: string;
}

// ============================================================================
// BedrockAgent
// ============================================================================

export class BedrockAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private fallbackAgent: FallbackAgent | null = null;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /**
   * Set the fallback agent (Claude SDK) for when Bedrock API fails.
   * Must be set after construction to avoid circular dependency.
   */
  setFallbackAgent(agent: FallbackAgent): void {
    this.fallbackAgent = agent;
  }

  /**
   * Start Bedrock agent for a session.
   * Uses multi-turn conversation to maintain context across messages.
   */
  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    try {
      const config = this.getBedrockConfig();

      // Generate synthetic memorySessionId (Bedrock is stateless)
      if (!session.memorySessionId) {
        const syntheticMemorySessionId = `bedrock-${session.contentSessionId}-${Date.now()}`;
        session.memorySessionId = syntheticMemorySessionId;
        this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);
        logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=Bedrock`);
      }

      // Load active mode
      const mode = ModeManager.getInstance().getActiveMode();

      // Build initial prompt
      const initPrompt = session.lastPromptNumber === 1
        ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
        : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

      // Add to conversation history and query Bedrock with full context
      session.conversationHistory.push({ role: 'user', content: initPrompt });
      const initResponse = await this.queryBedrockMultiTurn(session.conversationHistory, config);

      if (initResponse.content) {
        session.conversationHistory.push({ role: 'assistant', content: initResponse.content });

        const tokensUsed = initResponse.tokensUsed || 0;
        session.cumulativeInputTokens += initResponse.inputTokens || 0;
        session.cumulativeOutputTokens += initResponse.outputTokens || 0;

        await processAgentResponse(
          initResponse.content,
          session,
          this.dbManager,
          this.sessionManager,
          worker,
          tokensUsed,
          null,
          'Bedrock',
          undefined,
          config.model
        );
      } else {
        logger.error('SDK', 'Empty Bedrock init response - session may lack context', {
          sessionId: session.sessionDbId,
          model: config.model
        });
      }

      // Process pending messages
      let lastCwd: string | undefined;

      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        session.processingMessageIds.push(message._persistentId);

        if (message.cwd) {
          lastCwd = message.cwd;
        }
        const originalTimestamp = session.earliestPendingTimestamp;

        if (message.type === 'observation') {
          if (message.prompt_number !== undefined) {
            session.lastPromptNumber = message.prompt_number;
          }

          if (!session.memorySessionId) {
            throw new Error('Cannot process observations: memorySessionId not yet captured.');
          }

          const obsPrompt = buildObservationPrompt({
            id: 0,
            tool_name: message.tool_name!,
            tool_input: JSON.stringify(message.tool_input),
            tool_output: JSON.stringify(message.tool_response),
            created_at_epoch: originalTimestamp ?? Date.now(),
            cwd: message.cwd
          });

          session.conversationHistory.push({ role: 'user', content: obsPrompt });
          const obsResponse = await this.queryBedrockMultiTurn(session.conversationHistory, config);

          let tokensUsed = 0;
          if (obsResponse.content) {
            session.conversationHistory.push({ role: 'assistant', content: obsResponse.content });

            tokensUsed = obsResponse.tokensUsed || 0;
            session.cumulativeInputTokens += obsResponse.inputTokens || 0;
            session.cumulativeOutputTokens += obsResponse.outputTokens || 0;
          }

          if (obsResponse.content) {
            await processAgentResponse(
              obsResponse.content,
              session,
              this.dbManager,
              this.sessionManager,
              worker,
              tokensUsed,
              originalTimestamp,
              'Bedrock',
              lastCwd,
              config.model
            );
          } else {
            logger.warn('SDK', 'Empty Bedrock observation response, skipping processing', {
              sessionId: session.sessionDbId,
              messageId: session.processingMessageIds[session.processingMessageIds.length - 1]
            });
          }

        } else if (message.type === 'summarize') {
          if (!session.memorySessionId) {
            throw new Error('Cannot process summary: memorySessionId not yet captured.');
          }

          const summaryPrompt = buildSummaryPrompt({
            id: session.sessionDbId,
            memory_session_id: session.memorySessionId,
            project: session.project,
            user_prompt: session.userPrompt,
            last_assistant_message: message.last_assistant_message || ''
          }, mode);

          session.conversationHistory.push({ role: 'user', content: summaryPrompt });
          const summaryResponse = await this.queryBedrockMultiTurn(session.conversationHistory, config);

          let tokensUsed = 0;
          if (summaryResponse.content) {
            session.conversationHistory.push({ role: 'assistant', content: summaryResponse.content });

            tokensUsed = summaryResponse.tokensUsed || 0;
            session.cumulativeInputTokens += summaryResponse.inputTokens || 0;
            session.cumulativeOutputTokens += summaryResponse.outputTokens || 0;
          }

          if (summaryResponse.content) {
            await processAgentResponse(
              summaryResponse.content,
              session,
              this.dbManager,
              this.sessionManager,
              worker,
              tokensUsed,
              originalTimestamp,
              'Bedrock',
              lastCwd,
              config.model
            );
          } else {
            logger.warn('SDK', 'Empty Bedrock summary response, skipping processing', {
              sessionId: session.sessionDbId,
              messageId: session.processingMessageIds[session.processingMessageIds.length - 1]
            });
          }
        }
      }

      // Mark session complete
      const sessionDuration = Date.now() - session.startTime;
      logger.success('SDK', 'Bedrock agent completed', {
        sessionId: session.sessionDbId,
        duration: `${(sessionDuration / 1000).toFixed(1)}s`,
        historyLength: session.conversationHistory.length,
        model: config.model
      });

    } catch (error: unknown) {
      if (isAbortError(error)) {
        logger.warn('SDK', 'Bedrock agent aborted', { sessionId: session.sessionDbId });
        throw error;
      }

      // Check if we should fall back to Claude SDK
      if (shouldFallbackToClaude(error) && this.fallbackAgent) {
        logger.warn('SDK', 'Bedrock API failed, falling back to Claude SDK', {
          sessionDbId: session.sessionDbId,
          error: error instanceof Error ? error.message : String(error),
          historyLength: session.conversationHistory.length
        });
        return this.fallbackAgent.startSession(session, worker);
      }

      logger.failure('SDK', 'Bedrock agent error', { sessionDbId: session.sessionDbId }, error as Error);
      throw error;
    }
  }

  /**
   * Truncate conversation history to prevent runaway context costs.
   */
  private truncateHistory(history: ConversationMessage[]): ConversationMessage[] {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    const MAX_CONTEXT_MESSAGES = parseInt(settings.CLAUDE_MEM_BEDROCK_MAX_CONTEXT_MESSAGES) || DEFAULT_MAX_CONTEXT_MESSAGES;
    const MAX_ESTIMATED_TOKENS = parseInt(settings.CLAUDE_MEM_BEDROCK_MAX_TOKENS) || DEFAULT_MAX_ESTIMATED_TOKENS;

    if (history.length <= MAX_CONTEXT_MESSAGES) {
      const totalTokens = history.reduce((sum, m) => sum + estimateTokens(m.content), 0);
      if (totalTokens <= MAX_ESTIMATED_TOKENS) {
        return history;
      }
    }

    const truncated: ConversationMessage[] = [];
    let tokenCount = 0;

    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      const msgTokens = estimateTokens(msg.content);

      if (truncated.length > 0 && (truncated.length >= MAX_CONTEXT_MESSAGES || tokenCount + msgTokens > MAX_ESTIMATED_TOKENS)) {
        logger.warn('SDK', 'Bedrock context window truncated', {
          originalMessages: history.length,
          keptMessages: truncated.length,
          droppedMessages: i + 1,
          estimatedTokens: tokenCount,
          tokenLimit: MAX_ESTIMATED_TOKENS
        });
        break;
      }

      truncated.unshift(msg);
      tokenCount += msgTokens;
    }

    return truncated;
  }

  /**
   * Convert shared ConversationMessage array to Bedrock Messages API format.
   */
  private conversationToBedrockMessages(history: ConversationMessage[]): BedrockMessage[] {
    return history.map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' as const : 'user' as const,
      content: msg.content
    }));
  }

  /**
   * Resolve a model ID or portable tier alias to a Bedrock model ID.
   */
  private resolveModelId(model: string): string {
    return TIER_ALIASES[model] || model;
  }

  /**
   * Query Bedrock via InvokeModel API with truncated conversation history.
   */
  private async queryBedrockMultiTurn(
    history: ConversationMessage[],
    config: BedrockConfig
  ): Promise<{ content: string; tokensUsed?: number; inputTokens?: number; outputTokens?: number }> {
    const truncatedHistory = this.truncateHistory(history);
    const messages = this.conversationToBedrockMessages(truncatedHistory);
    const totalChars = truncatedHistory.reduce((sum, m) => sum + m.content.length, 0);

    // Resolve model ID (supports tier aliases like 'haiku')
    const modelId = this.resolveModelId(config.model);

    logger.debug('SDK', `Querying Bedrock multi-turn (${modelId})`, {
      turns: truncatedHistory.length,
      totalTurns: history.length,
      totalChars
    });

    // Build Anthropic Messages API request body for Bedrock
    const requestBody = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 4096,
      temperature: 0.3,
      messages,
    });

    // Build URL
    const encodedModelId = encodeURIComponent(modelId);
    const url = new URL(`https://bedrock-runtime.${config.credentials.region}.amazonaws.com/model/${encodedModelId}/invoke`);

    // Sign the request
    const signedHeaders = signRequest('POST', url, requestBody, config.credentials);

    // Make the request
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: signedHeaders,
      body: requestBody,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Bedrock API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as BedrockResponse;

    // Extract text from content blocks
    const textContent = data.content
      ?.filter(block => block.type === 'text' && block.text)
      .map(block => block.text!)
      .join('') || '';

    if (!textContent) {
      logger.error('SDK', 'Empty response from Bedrock', { model: modelId });
      return { content: '' };
    }

    const inputTokens = data.usage?.input_tokens || 0;
    const outputTokens = data.usage?.output_tokens || 0;
    const tokensUsed = inputTokens + outputTokens;

    if (tokensUsed > 0) {
      logger.info('SDK', 'Bedrock API usage', {
        model: modelId,
        inputTokens,
        outputTokens,
        totalTokens: tokensUsed,
        messagesInContext: truncatedHistory.length
      });
    }

    return { content: textContent, tokensUsed, inputTokens, outputTokens };
  }

  /**
   * Get Bedrock configuration from settings and environment variables.
   *
   * Credential resolution order:
   * 1. AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN from process.env
   *    (standard AWS credential chain — works with profiles, SSO, instance roles)
   *
   * Region resolution:
   * 1. CLAUDE_MEM_BEDROCK_REGION setting
   * 2. AWS_REGION env var
   * 3. AWS_DEFAULT_REGION env var
   */
  private getBedrockConfig(): BedrockConfig {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    // Region: settings > AWS_REGION > AWS_DEFAULT_REGION
    const region = settings.CLAUDE_MEM_BEDROCK_REGION
      || process.env.AWS_REGION
      || process.env.AWS_DEFAULT_REGION
      || '';

    if (!region) {
      throw new Error(
        'AWS region not configured for Bedrock. Set CLAUDE_MEM_BEDROCK_REGION in settings, or AWS_REGION environment variable.'
      );
    }

    // Credentials from environment (standard AWS credential chain)
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID || '';
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || '';
    const sessionToken = process.env.AWS_SESSION_TOKEN;

    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        'AWS credentials not found for Bedrock. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables.'
      );
    }

    // Model: settings > default
    const model = settings.CLAUDE_MEM_BEDROCK_MODEL || 'us.anthropic.claude-sonnet-4-6-v1';

    return {
      credentials: { accessKeyId, secretAccessKey, sessionToken, region },
      model,
    };
  }
}

/**
 * Check if Bedrock is available (has AWS credentials configured).
 */
export function isBedrockAvailable(): boolean {
  return !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
    && !!(
      SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH).CLAUDE_MEM_BEDROCK_REGION
      || process.env.AWS_REGION
      || process.env.AWS_DEFAULT_REGION
    );
}

/**
 * Check if Bedrock is the selected provider.
 */
export function isBedrockSelected(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return settings.CLAUDE_MEM_PROVIDER === 'bedrock';
}
