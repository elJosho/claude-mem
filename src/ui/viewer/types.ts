export interface Observation {
  id: number;
  memory_session_id: string;
  project: string;
  merged_into_project?: string | null;
  platform_source: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  text: string | null;
  facts: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number | null;
  created_at: string;
  created_at_epoch: number;
}

export interface Summary {
  id: number;
  session_id: string;
  project: string;
  platform_source: string;
  request?: string;
  investigated?: string;
  learned?: string;
  completed?: string;
  next_steps?: string;
  created_at_epoch: number;
}

export interface UserPrompt {
  id: number;
  content_session_id: string;
  project: string;
  platform_source: string;
  prompt_number: number;
  prompt_text: string;
  created_at_epoch: number;
}

export type FeedItem =
  | (Observation & { itemType: 'observation' })
  | (Summary & { itemType: 'summary' })
  | (UserPrompt & { itemType: 'prompt' });

export interface StreamEvent {
  type: 'initial_load' | 'new_observation' | 'new_summary' | 'new_prompt' | 'processing_status';
  observations?: Observation[];
  summaries?: Summary[];
  prompts?: UserPrompt[];
  projects?: string[];
  sources?: string[];
  projectsBySource?: Record<string, string[]>;
  observation?: Observation;
  summary?: Summary;
  prompt?: UserPrompt;
  isProcessing?: boolean;
  queueDepth?: number;
  totalPending?: number;
  totalProcessing?: number;
  totalFailed?: number;
}

export interface ProjectCatalog {
  projects: string[];
  sources: string[];
  projectsBySource: Record<string, string[]>;
}

export interface Settings {
  CLAUDE_MEM_MODEL: string;
  CLAUDE_MEM_CONTEXT_OBSERVATIONS: string;
  CLAUDE_MEM_WORKER_PORT: string;
  CLAUDE_MEM_WORKER_HOST: string;

  // AI Provider Configuration
  CLAUDE_MEM_PROVIDER?: string;  // 'claude' | 'gemini' | 'openrouter' | 'bedrock'
  CLAUDE_MEM_CLAUDE_AUTH_METHOD?: string;  // 'cli' | 'api'
  CLAUDE_MEM_GEMINI_API_KEY?: string;
  CLAUDE_MEM_GEMINI_MODEL?: string;
  CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED?: string;
  CLAUDE_MEM_OPENROUTER_API_KEY?: string;
  CLAUDE_MEM_OPENROUTER_MODEL?: string;
  CLAUDE_MEM_OPENROUTER_SITE_URL?: string;
  CLAUDE_MEM_OPENROUTER_APP_NAME?: string;

  // AWS Bedrock Configuration
  CLAUDE_MEM_BEDROCK_REGION?: string;
  CLAUDE_MEM_BEDROCK_MODEL?: string;

  // Token Economics Display
  CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS?: string;
  CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS?: string;
  CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT?: string;
  CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT?: string;

  // Display Configuration
  CLAUDE_MEM_CONTEXT_FULL_COUNT?: string;
  CLAUDE_MEM_CONTEXT_FULL_FIELD?: string;
  CLAUDE_MEM_CONTEXT_SESSION_COUNT?: string;

  // Feature Toggles
  CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY?: string;
  CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE?: string;
  CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT?: string;
  CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED?: string;
  CLAUDE_MEM_FOLDER_USE_LOCAL_MD?: string;
  CLAUDE_MEM_TRANSCRIPTS_ENABLED?: string;

  // Semantic Context Injection
  CLAUDE_MEM_SEMANTIC_INJECT?: string;
  CLAUDE_MEM_SEMANTIC_INJECT_LIMIT?: string;

  // Tier Routing
  CLAUDE_MEM_TIER_ROUTING_ENABLED?: string;
  CLAUDE_MEM_TIER_SIMPLE_MODEL?: string;
  CLAUDE_MEM_TIER_SUMMARY_MODEL?: string;

  // Chroma Vector Database
  CLAUDE_MEM_CHROMA_ENABLED?: string;
  CLAUDE_MEM_CHROMA_MODE?: string;
  CLAUDE_MEM_CHROMA_HOST?: string;
  CLAUDE_MEM_CHROMA_PORT?: string;

  // System Configuration
  CLAUDE_MEM_LOG_LEVEL?: string;
  CLAUDE_MEM_MAX_CONCURRENT_AGENTS?: string;

  // Exclusion Settings
  CLAUDE_MEM_EXCLUDED_PROJECTS?: string;
  CLAUDE_MEM_FOLDER_MD_EXCLUDE?: string;
}

export interface WorkerStats {
  version?: string;
  uptime?: number;
  activeSessions?: number;
  sseClients?: number;
}

export interface DatabaseStats {
  size?: number;
  observations?: number;
  sessions?: number;
  summaries?: number;
}

export interface Stats {
  worker?: WorkerStats;
  database?: DatabaseStats;
}
