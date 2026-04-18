import React, { useState, useCallback, useEffect } from 'react';
import type { Settings } from '../types';
import { TerminalPreview } from './TerminalPreview';
import { useContextPreview } from '../hooks/useContextPreview';

interface ContextSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: Settings;
  onSave: (settings: Settings) => void;
  isSaving: boolean;
  saveStatus: string;
}

// Collapsible section component
function CollapsibleSection({
  title,
  description,
  children,
  defaultOpen = true
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className={`settings-section-collapsible ${isOpen ? 'open' : ''}`}>
      <button
        className="section-header-btn"
        onClick={() => setIsOpen(!isOpen)}
        type="button"
      >
        <div className="section-header-content">
          <span className="section-title">{title}</span>
          {description && <span className="section-description">{description}</span>}
        </div>
        <svg
          className={`chevron-icon ${isOpen ? 'rotated' : ''}`}
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {isOpen && <div className="section-content">{children}</div>}
    </div>
  );
}

// Form field with optional tooltip
function FormField({
  label,
  tooltip,
  children
}: {
  label: string;
  tooltip?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="form-field">
      <label className="form-field-label">
        {label}
        {tooltip && (
          <span className="tooltip-trigger" title={tooltip}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </span>
        )}
      </label>
      {children}
    </div>
  );
}

// Toggle switch component
function ToggleSwitch({
  id,
  label,
  description,
  checked,
  onChange,
  disabled
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="toggle-row">
      <div className="toggle-info">
        <label htmlFor={id} className="toggle-label">{label}</label>
        {description && <span className="toggle-description">{description}</span>}
      </div>
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={checked}
        className={`toggle-switch ${checked ? 'on' : ''} ${disabled ? 'disabled' : ''}`}
        onClick={() => !disabled && onChange(!checked)}
        disabled={disabled}
      >
        <span className="toggle-knob" />
      </button>
    </div>
  );
}

export function ContextSettingsModal({
  isOpen,
  onClose,
  settings,
  onSave,
  isSaving,
  saveStatus
}: ContextSettingsModalProps) {
  const [formState, setFormState] = useState<Settings>(settings);

  // Update form state when settings prop changes
  useEffect(() => {
    setFormState(settings);
  }, [settings]);

  // Get context preview based on current form state
  const {
    preview,
    isLoading,
    error,
    projects,
    sources,
    selectedSource,
    setSelectedSource,
    selectedProject,
    setSelectedProject
  } = useContextPreview(formState);

  const updateSetting = useCallback((key: keyof Settings, value: string) => {
    const newState = { ...formState, [key]: value };
    setFormState(newState);
  }, [formState]);

  const handleSave = useCallback(() => {
    onSave(formState);
  }, [formState, onSave]);

  const toggleBoolean = useCallback((key: keyof Settings) => {
    const currentValue = formState[key];
    const newValue = currentValue === 'true' ? 'false' : 'true';
    updateSetting(key, newValue);
  }, [formState, updateSetting]);

  // Handle ESC key
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      window.addEventListener('keydown', handleEsc);
      return () => window.removeEventListener('keydown', handleEsc);
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="context-settings-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="modal-header">
          <h2>Settings</h2>
          <div className="header-controls">
            <label className="preview-selector">
              Source:
              <select
                value={selectedSource || ''}
                onChange={(e) => setSelectedSource(e.target.value)}
                disabled={sources.length === 0}
              >
                {sources.map(source => (
                  <option key={source} value={source}>{source}</option>
                ))}
              </select>
            </label>
            <label className="preview-selector">
              Project:
              <select
                value={selectedProject || ''}
                onChange={(e) => setSelectedProject(e.target.value)}
                disabled={projects.length === 0}
              >
                {projects.map(project => (
                  <option key={project} value={project}>{project}</option>
                ))}
              </select>
            </label>
            <button
              onClick={onClose}
              className="modal-close-btn"
              title="Close (Esc)"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body - 2 columns */}
        <div className="modal-body">
          {/* Left column - Terminal Preview */}
          <div className="preview-column">
            <div className="preview-content">
              {error ? (
                <div style={{ color: '#ff6b6b' }}>
                  Error loading preview: {error}
                </div>
              ) : (
                <TerminalPreview content={preview} isLoading={isLoading} />
              )}
            </div>
          </div>

          {/* Right column - Settings Panel */}
          <div className="settings-column">
            {/* Section 1: Loading */}
            <CollapsibleSection
              title="Loading"
              description="How many observations to inject"
            >
              <FormField
                label="Observations"
                tooltip="Number of recent observations to include in context (1-200)"
              >
                <input
                  type="number"
                  min="1"
                  max="200"
                  value={formState.CLAUDE_MEM_CONTEXT_OBSERVATIONS || '50'}
                  onChange={(e) => updateSetting('CLAUDE_MEM_CONTEXT_OBSERVATIONS', e.target.value)}
                />
              </FormField>
              <FormField
                label="Sessions"
                tooltip="Number of recent sessions to pull observations from (1-50)"
              >
                <input
                  type="number"
                  min="1"
                  max="50"
                  value={formState.CLAUDE_MEM_CONTEXT_SESSION_COUNT || '10'}
                  onChange={(e) => updateSetting('CLAUDE_MEM_CONTEXT_SESSION_COUNT', e.target.value)}
                />
              </FormField>
            </CollapsibleSection>

            {/* Section 2: Display */}
            <CollapsibleSection
              title="Display"
              description="What to show in context tables"
            >
              <div className="display-subsection">
                <span className="subsection-label">Full Observations</span>
                <FormField
                  label="Count"
                  tooltip="How many observations show expanded details (0-20)"
                >
                  <input
                    type="number"
                    min="0"
                    max="20"
                    value={formState.CLAUDE_MEM_CONTEXT_FULL_COUNT || '5'}
                    onChange={(e) => updateSetting('CLAUDE_MEM_CONTEXT_FULL_COUNT', e.target.value)}
                  />
                </FormField>
                <FormField
                  label="Field"
                  tooltip="Which field to expand for full observations"
                >
                  <select
                    value={formState.CLAUDE_MEM_CONTEXT_FULL_FIELD || 'narrative'}
                    onChange={(e) => updateSetting('CLAUDE_MEM_CONTEXT_FULL_FIELD', e.target.value)}
                  >
                    <option value="narrative">Narrative</option>
                    <option value="facts">Facts</option>
                  </select>
                </FormField>
              </div>

              <div className="display-subsection">
                <span className="subsection-label">Token Economics</span>
                <div className="toggle-group">
                  <ToggleSwitch
                    id="show-read-tokens"
                    label="Read cost"
                    description="Tokens to read this observation"
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS')}
                  />
                  <ToggleSwitch
                    id="show-work-tokens"
                    label="Work investment"
                    description="Tokens spent creating this observation"
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS')}
                  />
                  <ToggleSwitch
                    id="show-savings-amount"
                    label="Savings"
                    description="Total tokens saved by reusing context"
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT')}
                  />
                </div>
              </div>
            </CollapsibleSection>

            {/* Section 3: AI Provider */}
            <CollapsibleSection
              title="AI Provider"
              description="Model and provider for generating observations"
              defaultOpen={false}
            >
              <FormField
                label="Provider"
                tooltip="Choose which AI provider processes your observations"
              >
                <select
                  value={formState.CLAUDE_MEM_PROVIDER || 'claude'}
                  onChange={(e) => updateSetting('CLAUDE_MEM_PROVIDER', e.target.value)}
                >
                  <option value="claude">Claude (uses your Claude account)</option>
                  <option value="bedrock">AWS Bedrock (uses AWS credentials)</option>
                  <option value="gemini">Gemini (uses API key)</option>
                  <option value="openrouter">OpenRouter (multi-model)</option>
                </select>
              </FormField>

              {formState.CLAUDE_MEM_PROVIDER === 'claude' && (
                <>
                  <FormField
                    label="Model"
                    tooltip="Claude model used for generating observations"
                  >
                    <select
                      value={formState.CLAUDE_MEM_MODEL || 'haiku'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_MODEL', e.target.value)}
                    >
                      <option value="haiku">haiku (fastest)</option>
                      <option value="sonnet">sonnet (balanced)</option>
                      <option value="opus">opus (highest quality)</option>
                    </select>
                  </FormField>
                  <FormField
                    label="Auth Method"
                    tooltip="How Claude authenticates: 'cli' uses your Claude subscription, 'api' uses an API key"
                  >
                    <select
                      value={formState.CLAUDE_MEM_CLAUDE_AUTH_METHOD || 'cli'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_CLAUDE_AUTH_METHOD', e.target.value)}
                    >
                      <option value="cli">CLI (subscription billing)</option>
                      <option value="api">API Key</option>
                    </select>
                  </FormField>
                </>
              )}

              {formState.CLAUDE_MEM_PROVIDER === 'bedrock' && (
                <>
                  <FormField
                    label="Region"
                    tooltip="AWS region for Bedrock (leave blank to use AWS_REGION env var)"
                  >
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_BEDROCK_REGION || ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_BEDROCK_REGION', e.target.value)}
                      placeholder="e.g., us-east-1 (or leave blank for env var)"
                    />
                  </FormField>
                  <FormField
                    label="Model"
                    tooltip="Bedrock model ID or alias (haiku, sonnet, opus)"
                  >
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_BEDROCK_MODEL || 'us.anthropic.claude-sonnet-4-6-v1'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_BEDROCK_MODEL', e.target.value)}
                      placeholder="e.g., us.anthropic.claude-sonnet-4-6-v1"
                    />
                  </FormField>
                </>
              )}

              {formState.CLAUDE_MEM_PROVIDER === 'gemini' && (
                <>
                  <FormField
                    label="API Key"
                    tooltip="Your Google AI Studio API key (or set GEMINI_API_KEY env var)"
                  >
                    <input
                      type="password"
                      value={formState.CLAUDE_MEM_GEMINI_API_KEY || ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_GEMINI_API_KEY', e.target.value)}
                      placeholder="Enter Gemini API key..."
                    />
                  </FormField>
                  <FormField
                    label="Model"
                    tooltip="Gemini model used for generating observations"
                  >
                    <select
                      value={formState.CLAUDE_MEM_GEMINI_MODEL || 'gemini-2.5-flash-lite'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_GEMINI_MODEL', e.target.value)}
                    >
                      <option value="gemini-2.5-flash-lite">gemini-2.5-flash-lite (10 RPM free)</option>
                      <option value="gemini-2.5-flash">gemini-2.5-flash (5 RPM free)</option>
                      <option value="gemini-3-flash-preview">gemini-3-flash-preview (5 RPM free)</option>
                    </select>
                  </FormField>
                  <div className="toggle-group" style={{ marginTop: '8px' }}>
                    <ToggleSwitch
                      id="gemini-rate-limiting"
                      label="Rate Limiting"
                      description="Enable for free tier (10-30 RPM). Disable if you have billing set up."
                      checked={formState.CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED === 'true'}
                      onChange={(checked) => updateSetting('CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED', checked ? 'true' : 'false')}
                    />
                  </div>
                </>
              )}

              {formState.CLAUDE_MEM_PROVIDER === 'openrouter' && (
                <>
                  <FormField
                    label="API Key"
                    tooltip="Your OpenRouter API key from openrouter.ai (or set OPENROUTER_API_KEY env var)"
                  >
                    <input
                      type="password"
                      value={formState.CLAUDE_MEM_OPENROUTER_API_KEY || ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_OPENROUTER_API_KEY', e.target.value)}
                      placeholder="Enter OpenRouter API key..."
                    />
                  </FormField>
                  <FormField
                    label="Model"
                    tooltip="Model identifier from OpenRouter (e.g., anthropic/claude-3.5-sonnet)"
                  >
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_OPENROUTER_MODEL || 'xiaomi/mimo-v2-flash:free'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_OPENROUTER_MODEL', e.target.value)}
                      placeholder="e.g., xiaomi/mimo-v2-flash:free"
                    />
                  </FormField>
                  <FormField
                    label="Site URL (Optional)"
                    tooltip="Your site URL for OpenRouter analytics"
                  >
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_OPENROUTER_SITE_URL || ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_OPENROUTER_SITE_URL', e.target.value)}
                      placeholder="https://yoursite.com"
                    />
                  </FormField>
                  <FormField
                    label="App Name (Optional)"
                    tooltip="Your app name for OpenRouter analytics"
                  >
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_OPENROUTER_APP_NAME || 'claude-mem'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_OPENROUTER_APP_NAME', e.target.value)}
                      placeholder="claude-mem"
                    />
                  </FormField>
                </>
              )}
            </CollapsibleSection>

            {/* Section 4: Tier Routing */}
            <CollapsibleSection
              title="Tier Routing"
              description="Route observations to models by complexity"
              defaultOpen={false}
            >
              <ToggleSwitch
                id="tier-routing-enabled"
                label="Enable Tier Routing"
                description="Use cheaper models for simple observations, full model for complex ones"
                checked={formState.CLAUDE_MEM_TIER_ROUTING_ENABLED === 'true'}
                onChange={() => toggleBoolean('CLAUDE_MEM_TIER_ROUTING_ENABLED')}
              />
              {formState.CLAUDE_MEM_TIER_ROUTING_ENABLED === 'true' && (
                <>
                  <FormField
                    label="Simple Model"
                    tooltip="Model alias or ID for simple tool observations (Read, Glob, Grep). Use 'haiku' for portable alias."
                  >
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_TIER_SIMPLE_MODEL || 'haiku'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_TIER_SIMPLE_MODEL', e.target.value)}
                      placeholder="e.g., haiku"
                    />
                  </FormField>
                  <FormField
                    label="Summary Model"
                    tooltip="Model alias or ID for session summaries. Leave blank to use the default model."
                  >
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_TIER_SUMMARY_MODEL || ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_TIER_SUMMARY_MODEL', e.target.value)}
                      placeholder="Leave blank for default model"
                    />
                  </FormField>
                </>
              )}
            </CollapsibleSection>

            {/* Section 5: Features */}
            <CollapsibleSection
              title="Features"
              description="Toggle optional capabilities"
              defaultOpen={false}
            >
              <div className="display-subsection">
                <span className="subsection-label">Context Injection</span>
                <div className="toggle-group">
                  <ToggleSwitch
                    id="show-last-summary"
                    label="Include last summary"
                    description="Add previous session's summary to context"
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY')}
                  />
                  <ToggleSwitch
                    id="show-last-message"
                    label="Include last message"
                    description="Add previous session's final message"
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE')}
                  />
                  <ToggleSwitch
                    id="show-terminal-output"
                    label="Include terminal output"
                    description="Add terminal command output to observations"
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT')}
                  />
                </div>
              </div>

              <div className="display-subsection">
                <span className="subsection-label">Semantic Search</span>
                <div className="toggle-group">
                  <ToggleSwitch
                    id="semantic-inject"
                    label="Semantic injection"
                    description="Inject relevant past observations on every prompt via Chroma vector search"
                    checked={formState.CLAUDE_MEM_SEMANTIC_INJECT === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_SEMANTIC_INJECT')}
                  />
                </div>
                {formState.CLAUDE_MEM_SEMANTIC_INJECT === 'true' && (
                  <FormField
                    label="Injection Limit"
                    tooltip="Max observations to inject per prompt (1-20)"
                  >
                    <input
                      type="number"
                      min="1"
                      max="20"
                      value={formState.CLAUDE_MEM_SEMANTIC_INJECT_LIMIT || '5'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_SEMANTIC_INJECT_LIMIT', e.target.value)}
                    />
                  </FormField>
                )}
              </div>

              <div className="display-subsection">
                <span className="subsection-label">Integrations</span>
                <div className="toggle-group">
                  <ToggleSwitch
                    id="folder-claudemd"
                    label="Folder CLAUDE.md"
                    description="Write project-level CLAUDE.md files with memory context"
                    checked={formState.CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED')}
                  />
                  {formState.CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED === 'true' && (
                    <ToggleSwitch
                      id="folder-use-local-md"
                      label="Use CLAUDE.local.md"
                      description="Write to CLAUDE.local.md instead of CLAUDE.md"
                      checked={formState.CLAUDE_MEM_FOLDER_USE_LOCAL_MD === 'true'}
                      onChange={() => toggleBoolean('CLAUDE_MEM_FOLDER_USE_LOCAL_MD')}
                    />
                  )}
                  <ToggleSwitch
                    id="transcripts-enabled"
                    label="Transcript ingestion"
                    description="Watch and ingest transcripts from Codex and other clients"
                    checked={formState.CLAUDE_MEM_TRANSCRIPTS_ENABLED === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_TRANSCRIPTS_ENABLED')}
                  />
                </div>
              </div>

              <div className="display-subsection">
                <span className="subsection-label">Exclusions</span>
                <FormField
                  label="Excluded Projects"
                  tooltip="Comma-separated glob patterns for project paths to exclude from memory (e.g., */node_modules/*,*/tmp/*)"
                >
                  <input
                    type="text"
                    value={formState.CLAUDE_MEM_EXCLUDED_PROJECTS || ''}
                    onChange={(e) => updateSetting('CLAUDE_MEM_EXCLUDED_PROJECTS', e.target.value)}
                    placeholder="e.g., */node_modules/*,*/tmp/*"
                  />
                </FormField>
              </div>
            </CollapsibleSection>

            {/* Section 6: Vector Search */}
            <CollapsibleSection
              title="Vector Search"
              description="Chroma embedding database configuration"
              defaultOpen={false}
            >
              <ToggleSwitch
                id="chroma-enabled"
                label="Enable Chroma"
                description="Use Chroma vector DB for semantic search. Disable for SQLite-only mode."
                checked={formState.CLAUDE_MEM_CHROMA_ENABLED === 'true'}
                onChange={() => toggleBoolean('CLAUDE_MEM_CHROMA_ENABLED')}
              />
              {formState.CLAUDE_MEM_CHROMA_ENABLED === 'true' && (
                <>
                  <FormField
                    label="Mode"
                    tooltip="'local' runs an embedded Chroma instance, 'remote' connects to an existing server"
                  >
                    <select
                      value={formState.CLAUDE_MEM_CHROMA_MODE || 'local'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_CHROMA_MODE', e.target.value)}
                    >
                      <option value="local">Local (embedded)</option>
                      <option value="remote">Remote (connect to server)</option>
                    </select>
                  </FormField>
                  {formState.CLAUDE_MEM_CHROMA_MODE === 'remote' && (
                    <>
                      <FormField
                        label="Host"
                        tooltip="Chroma server hostname or IP"
                      >
                        <input
                          type="text"
                          value={formState.CLAUDE_MEM_CHROMA_HOST || '127.0.0.1'}
                          onChange={(e) => updateSetting('CLAUDE_MEM_CHROMA_HOST', e.target.value)}
                          placeholder="127.0.0.1"
                        />
                      </FormField>
                      <FormField
                        label="Port"
                        tooltip="Chroma server port"
                      >
                        <input
                          type="number"
                          min="1"
                          max="65535"
                          value={formState.CLAUDE_MEM_CHROMA_PORT || '8000'}
                          onChange={(e) => updateSetting('CLAUDE_MEM_CHROMA_PORT', e.target.value)}
                        />
                      </FormField>
                    </>
                  )}
                </>
              )}
            </CollapsibleSection>

            {/* Section 7: System */}
            <CollapsibleSection
              title="System"
              description="Worker and process configuration"
              defaultOpen={false}
            >
              <FormField
                label="Worker Port"
                tooltip="Port for the background worker service (requires restart)"
              >
                <input
                  type="number"
                  min="1024"
                  max="65535"
                  value={formState.CLAUDE_MEM_WORKER_PORT || '37777'}
                  onChange={(e) => updateSetting('CLAUDE_MEM_WORKER_PORT', e.target.value)}
                />
              </FormField>
              <FormField
                label="Log Level"
                tooltip="Verbosity of worker logs"
              >
                <select
                  value={formState.CLAUDE_MEM_LOG_LEVEL || 'INFO'}
                  onChange={(e) => updateSetting('CLAUDE_MEM_LOG_LEVEL', e.target.value)}
                >
                  <option value="DEBUG">DEBUG</option>
                  <option value="INFO">INFO</option>
                  <option value="WARN">WARN</option>
                  <option value="ERROR">ERROR</option>
                </select>
              </FormField>
              <FormField
                label="Max Concurrent Agents"
                tooltip="Maximum number of concurrent Claude SDK agent subprocesses (1-10)"
              >
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={formState.CLAUDE_MEM_MAX_CONCURRENT_AGENTS || '2'}
                  onChange={(e) => updateSetting('CLAUDE_MEM_MAX_CONCURRENT_AGENTS', e.target.value)}
                />
              </FormField>
            </CollapsibleSection>
          </div>
        </div>

        {/* Footer with Save button */}
        <div className="modal-footer">
          <div className="save-status">
            {saveStatus && <span className={saveStatus.includes('✓') ? 'success' : saveStatus.includes('✗') ? 'error' : ''}>{saveStatus}</span>}
          </div>
          <button
            className="save-btn"
            onClick={handleSave}
            disabled={isSaving}
          >
            {isSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
