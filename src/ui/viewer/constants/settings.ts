/**
 * Default settings values for Claude Memory
 * Shared across UI components and hooks
 * Keep in sync with SettingsDefaultsManager.ts
 */
export const DEFAULT_SETTINGS = {
  CLAUDE_MEM_MODEL: 'claude-sonnet-4-6',
  CLAUDE_MEM_CONTEXT_OBSERVATIONS: '50',
  CLAUDE_MEM_WORKER_PORT: '37777',
  CLAUDE_MEM_WORKER_HOST: '127.0.0.1',

  // AI Provider Configuration
  CLAUDE_MEM_PROVIDER: 'claude',
  CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'cli',
  CLAUDE_MEM_GEMINI_API_KEY: '',
  CLAUDE_MEM_GEMINI_MODEL: 'gemini-2.5-flash-lite',
  CLAUDE_MEM_OPENROUTER_API_KEY: '',
  CLAUDE_MEM_OPENROUTER_MODEL: 'xiaomi/mimo-v2-flash:free',
  CLAUDE_MEM_OPENROUTER_SITE_URL: '',
  CLAUDE_MEM_OPENROUTER_APP_NAME: 'claude-mem',
  CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: 'true',

  // AWS Bedrock Configuration
  CLAUDE_MEM_BEDROCK_REGION: '',
  CLAUDE_MEM_BEDROCK_MODEL: 'us.anthropic.claude-sonnet-4-6-v1',

  // Token Economics — match SettingsDefaultsManager defaults (off by default to keep context lean)
  CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS: 'false',
  CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS: 'false',
  CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: 'false',
  CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: 'true',

  // Display Configuration — match SettingsDefaultsManager defaults
  CLAUDE_MEM_CONTEXT_FULL_COUNT: '0',
  CLAUDE_MEM_CONTEXT_FULL_FIELD: 'narrative',
  CLAUDE_MEM_CONTEXT_SESSION_COUNT: '10',

  // Feature Toggles
  CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY: 'true',
  CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'false',
  CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'true',
  CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
  CLAUDE_MEM_FOLDER_USE_LOCAL_MD: 'false',
  CLAUDE_MEM_TRANSCRIPTS_ENABLED: 'true',

  // Semantic Context Injection
  CLAUDE_MEM_SEMANTIC_INJECT: 'false',
  CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '5',

  // Tier Routing
  CLAUDE_MEM_TIER_ROUTING_ENABLED: 'true',
  CLAUDE_MEM_TIER_SIMPLE_MODEL: 'haiku',
  CLAUDE_MEM_TIER_SUMMARY_MODEL: '',

  // Chroma Vector Database
  CLAUDE_MEM_CHROMA_ENABLED: 'true',
  CLAUDE_MEM_CHROMA_MODE: 'local',
  CLAUDE_MEM_CHROMA_HOST: '127.0.0.1',
  CLAUDE_MEM_CHROMA_PORT: '8000',

  // System Configuration
  CLAUDE_MEM_LOG_LEVEL: 'INFO',
  CLAUDE_MEM_MAX_CONCURRENT_AGENTS: '2',

  // Exclusion Settings
  CLAUDE_MEM_EXCLUDED_PROJECTS: '',
  CLAUDE_MEM_FOLDER_MD_EXCLUDE: '[]',
} as const;
