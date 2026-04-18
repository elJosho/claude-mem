/**
 * Store observation function
 * Extracted from SessionStore.ts for modular organization
 */

import { createHash } from 'crypto';
import { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';
import { sanitizeObservationInputForStorage } from '../../../utils/tag-stripping.js';
import { getCurrentProjectName } from '../../../shared/paths.js';
import type { ObservationInput, StoreObservationResult } from './types.js';

/** Deduplication window: observations with the same content hash within this window are skipped */
const DEDUP_WINDOW_MS = 30_000;

/** Cross-session echo dedup window: 7 days in milliseconds */
const ECHO_DEDUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Compute a short content hash for deduplication.
 * Uses (memory_session_id, title, narrative) as the semantic identity of an observation.
 */
export function computeObservationContentHash(
  memorySessionId: string,
  title: string | null,
  narrative: string | null
): string {
  return createHash('sha256')
    .update([memorySessionId || '', title || '', narrative || ''].join('\x00'))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Check if a duplicate observation exists within the dedup window.
 * Returns the existing observation's id and timestamp if found, null otherwise.
 */
export function findDuplicateObservation(
  db: Database,
  contentHash: string,
  timestampEpoch: number
): { id: number; created_at_epoch: number } | null {
  const windowStart = timestampEpoch - DEDUP_WINDOW_MS;
  const stmt = db.prepare(
    'SELECT id, created_at_epoch FROM observations WHERE content_hash = ? AND created_at_epoch > ?'
  );
  return (stmt.get(contentHash, windowStart) as { id: number; created_at_epoch: number } | null);
}

/**
 * Compute a session-agnostic content hash for cross-session echo detection.
 * Uses only (title, narrative) — no memorySessionId — so the same semantic
 * content from different sessions produces the same hash.
 */
export function computeEchoContentHash(
  title: string | null,
  narrative: string | null
): string {
  // Normalize: lowercase, collapse whitespace, trim
  const normTitle = (title || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const normNarrative = (narrative || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256')
    .update([normTitle, normNarrative].join('\x00'))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Extract terms from text for similarity comparison.
 * Splits on non-alphanumeric characters, lowercases, keeps 3+ char terms.
 */
function extractTerms(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3)
  );
}

/**
 * Compute overlap ratio: shared terms / min(|a|, |b|).
 * Returns 0.0-1.0. A high value means most terms from the shorter title
 * appear in the longer one — strong signal of semantic duplication.
 */
function titleOverlapRatio(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0.0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  return intersection / Math.min(a.size, b.size);
}

/** Title overlap threshold for echo detection.
 * 0.6 means 60% of the shorter title's terms must appear in the longer title. */
const ECHO_TITLE_OVERLAP_THRESHOLD = 0.6;

/** Minimum terms required in both titles to attempt fuzzy matching.
 * Prevents false positives on very short titles like "Bug fix". */
const MIN_TERMS_FOR_FUZZY = 3;

/**
 * Check if a semantically similar observation already exists for this project
 * within the echo dedup window (7 days). This prevents the "echo amplification"
 * bug where AI-generated observations restate content from injected context,
 * creating duplicates across sessions.
 *
 * Uses two strategies:
 * 1. Exact normalized hash match (title + narrative, session-agnostic)
 * 2. Fuzzy title keyword similarity (Jaccard >= 0.6)
 *
 * Unlike findDuplicateObservation (same-session, 30s), this is:
 * - Session-agnostic (ignores memorySessionId)
 * - Project-scoped (only matches same project)
 * - Wide window (7 days)
 * - Handles LLM rephrasing via keyword similarity
 */
export function findEchoDuplicate(
  db: Database,
  project: string,
  echoHash: string,
  newTitle: string | null,
  timestampEpoch: number
): { id: number; created_at_epoch: number; title: string | null } | null {
  const windowStart = timestampEpoch - ECHO_DEDUP_WINDOW_MS;
  // We can't index on echo_hash without a schema migration, so we compute and compare in JS.
  // Query recent observations for this project and check echo hashes + title similarity.
  const recentStmt = db.prepare(
    'SELECT id, created_at_epoch, title, narrative FROM observations WHERE project = ? AND created_at_epoch > ? ORDER BY created_at_epoch DESC LIMIT 500'
  );
  const rows = recentStmt.all(project, windowStart) as Array<{
    id: number;
    created_at_epoch: number;
    title: string | null;
    narrative: string | null;
  }>;

  const newTitleTerms = extractTerms(newTitle || '');

  for (const row of rows) {
    // Strategy 1: Exact normalized hash match
    const rowHash = computeEchoContentHash(row.title, row.narrative);
    if (rowHash === echoHash) {
      return { id: row.id, created_at_epoch: row.created_at_epoch, title: row.title };
    }

    // Strategy 2: Fuzzy title overlap (containment ratio >= 0.6)
    if (newTitleTerms.size >= MIN_TERMS_FOR_FUZZY) {
      const rowTitleTerms = extractTerms(row.title || '');
      if (rowTitleTerms.size >= MIN_TERMS_FOR_FUZZY) {
        const overlap = titleOverlapRatio(newTitleTerms, rowTitleTerms);
        if (overlap >= ECHO_TITLE_OVERLAP_THRESHOLD) {
          return { id: row.id, created_at_epoch: row.created_at_epoch, title: row.title };
        }
      }
    }
  }
  return null;
}

/**
 * Store an observation (from SDK parsing)
 * Assumes session already exists (created by hook)
 * Performs content-hash deduplication: skips INSERT if an identical observation exists within 30s
 */
export function storeObservation(
  db: Database,
  memorySessionId: string,
  project: string,
  observation: ObservationInput,
  promptNumber?: number,
  discoveryTokens: number = 0,
  overrideTimestampEpoch?: number
): StoreObservationResult {
  const sanitized = sanitizeObservationInputForStorage(observation);

  // Use override timestamp if provided (for processing backlog messages with original timestamps)
  const timestampEpoch = overrideTimestampEpoch ?? Date.now();
  const timestampIso = new Date(timestampEpoch).toISOString();

  // Guard against empty project string (race condition where project isn't set yet)
  const resolvedProject = project || getCurrentProjectName();

  // Content-hash deduplication (same-session, 30s window)
  const contentHash = computeObservationContentHash(memorySessionId, sanitized.title, sanitized.narrative);
  const existing = findDuplicateObservation(db, contentHash, timestampEpoch);
  if (existing) {
    logger.debug('DEDUP', `Skipped duplicate observation | contentHash=${contentHash} | existingId=${existing.id}`);
    return { id: existing.id, createdAtEpoch: existing.created_at_epoch };
  }

  // Cross-session echo dedup (7-day window, project-scoped, session-agnostic)
  const echoHash = computeEchoContentHash(sanitized.title, sanitized.narrative);
  const echoDup = findEchoDuplicate(db, resolvedProject, echoHash, sanitized.title, timestampEpoch);
  if (echoDup) {
    logger.info('ECHO_DEDUP', `Skipped echo observation | title="${sanitized.title}" | echoOf=obs#${echoDup.id} ("${echoDup.title}")`, {
      memorySessionId, project: resolvedProject
    });
    return { id: echoDup.id, createdAtEpoch: echoDup.created_at_epoch };
  }

  const stmt = db.prepare(`
    INSERT INTO observations
    (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
     files_read, files_modified, prompt_number, discovery_tokens, content_hash, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    memorySessionId,
    resolvedProject,
    sanitized.type,
    sanitized.title,
    sanitized.subtitle,
    JSON.stringify(sanitized.facts),
    sanitized.narrative,
    JSON.stringify(sanitized.concepts),
    JSON.stringify(sanitized.files_read),
    JSON.stringify(sanitized.files_modified),
    promptNumber || null,
    discoveryTokens,
    contentHash,
    timestampIso,
    timestampEpoch
  );

  return {
    id: Number(result.lastInsertRowid),
    createdAtEpoch: timestampEpoch
  };
}
