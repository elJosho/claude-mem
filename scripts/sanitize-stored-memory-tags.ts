#!/usr/bin/env bun
/**
 * One-off: strip memory/control tags from existing observations and session_summaries
 * (same rules as sanitizeObservationInputForStorage / sanitizeSummaryInputForStorage).
 *
 * Usage:
 *   bun scripts/sanitize-stored-memory-tags.ts           # dry-run: counts rows that would change
 *   bun scripts/sanitize-stored-memory-tags.ts --execute # apply updates
 *
 * Uses DB_PATH from ~/.claude-mem unless CLAUDE_MEM_DATA_DIR is set (see src/shared/paths.js).
 */

import { Database } from 'bun:sqlite';
import { DB_PATH } from '../src/shared/paths.js';
import {
  sanitizeObservationInputForStorage,
  sanitizeSummaryInputForStorage,
  stripMemoryTagsFromPrompt
} from '../src/utils/tag-stripping.js';
import { computeObservationContentHash } from '../src/services/sqlite/observations/store.js';

function safeJsonStringArray(raw: string | null): string[] {
  if (raw == null || raw === '') return [];
  try {
    const p = JSON.parse(raw) as unknown;
    if (!Array.isArray(p)) return [];
    return p.map((x) => String(x));
  } catch {
    return [];
  }
}

function hasColumn(db: Database, table: string, name: string): boolean {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === name);
}

function main(): void {
  const execute = process.argv.includes('--execute');
  const dbPath = process.env.CLAUDE_MEM_DB_PATH ?? DB_PATH;
  const db = new Database(dbPath);

  const obsCols = hasColumn(db, 'observations', 'content_hash');
  const sumFilesRead = hasColumn(db, 'session_summaries', 'files_read');
  const sumFilesEdited = hasColumn(db, 'session_summaries', 'files_edited');

  const obsRows = db
    .query(
      `SELECT id, memory_session_id, type, title, subtitle, narrative, facts, concepts, files_read, files_modified, text
       FROM observations`
    )
    .all() as Array<{
    id: number;
    memory_session_id: string;
    type: string;
    title: string | null;
    subtitle: string | null;
    narrative: string | null;
    facts: string | null;
    concepts: string | null;
    files_read: string | null;
    files_modified: string | null;
    text: string | null;
  }>;

  let obsWouldChange = 0;
  let obsUpdated = 0;

  const updateObs = db.prepare(`
    UPDATE observations SET
      title = ?,
      subtitle = ?,
      narrative = ?,
      facts = ?,
      concepts = ?,
      files_read = ?,
      files_modified = ?,
      text = ?${obsCols ? ', content_hash = ?' : ''}
    WHERE id = ?
  `);

  for (const row of obsRows) {
    const facts = safeJsonStringArray(row.facts);
    const concepts = safeJsonStringArray(row.concepts);
    const filesRead = safeJsonStringArray(row.files_read);
    const filesModified = safeJsonStringArray(row.files_modified);

    const sanitized = sanitizeObservationInputForStorage({
      type: row.type,
      title: row.title,
      subtitle: row.subtitle,
      narrative: row.narrative,
      facts,
      concepts,
      files_read: filesRead,
      files_modified: filesModified
    });

    let newText: string | null = row.text;
    if (row.text != null && row.text !== '') {
      const t = stripMemoryTagsFromPrompt(row.text);
      newText = t === '' ? null : t;
    }

    const factsJson = JSON.stringify(sanitized.facts);
    const conceptsJson = JSON.stringify(sanitized.concepts);
    const frJson = JSON.stringify(sanitized.files_read);
    const fmJson = JSON.stringify(sanitized.files_modified);

    const changed =
      sanitized.title !== row.title ||
      sanitized.subtitle !== row.subtitle ||
      sanitized.narrative !== row.narrative ||
      factsJson !== (row.facts ?? '[]') ||
      conceptsJson !== (row.concepts ?? '[]') ||
      frJson !== (row.files_read ?? '[]') ||
      fmJson !== (row.files_modified ?? '[]') ||
      newText !== row.text;

    if (!changed) continue;
    obsWouldChange++;

    if (!execute) continue;

    if (obsCols) {
      const hash = computeObservationContentHash(row.memory_session_id, sanitized.title, sanitized.narrative);
      updateObs.run(
        sanitized.title,
        sanitized.subtitle,
        sanitized.narrative,
        factsJson,
        conceptsJson,
        frJson,
        fmJson,
        newText,
        hash,
        row.id
      );
    } else {
      db.prepare(`
        UPDATE observations SET
          title = ?, subtitle = ?, narrative = ?, facts = ?, concepts = ?,
          files_read = ?, files_modified = ?, text = ?
        WHERE id = ?
      `).run(
        sanitized.title,
        sanitized.subtitle,
        sanitized.narrative,
        factsJson,
        conceptsJson,
        frJson,
        fmJson,
        newText,
        row.id
      );
    }
    obsUpdated++;
  }

  const sumRows = db
    .query(
      `SELECT id, request, investigated, learned, completed, next_steps, notes${sumFilesRead ? ', files_read' : ''}${sumFilesEdited ? ', files_edited' : ''}
       FROM session_summaries`
    )
    .all() as Array<{
    id: number;
    request: string | null;
    investigated: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    notes: string | null;
    files_read?: string | null;
    files_edited?: string | null;
  }>;

  let sumWouldChange = 0;
  let sumUpdated = 0;

  for (const row of sumRows) {
    const sanitized = sanitizeSummaryInputForStorage({
      request: row.request ?? '',
      investigated: row.investigated ?? '',
      learned: row.learned ?? '',
      completed: row.completed ?? '',
      next_steps: row.next_steps ?? '',
      notes: row.notes
    });

    let newFr: string | null | undefined = row.files_read;
    let newFe: string | null | undefined = row.files_edited;
    if (sumFilesRead && row.files_read != null && row.files_read !== '') {
      const t = stripMemoryTagsFromPrompt(row.files_read);
      newFr = t === '' ? null : t;
    }
    if (sumFilesEdited && row.files_edited != null && row.files_edited !== '') {
      const t = stripMemoryTagsFromPrompt(row.files_edited);
      newFe = t === '' ? null : t;
    }

    const changed =
      sanitized.request !== (row.request ?? '') ||
      sanitized.investigated !== (row.investigated ?? '') ||
      sanitized.learned !== (row.learned ?? '') ||
      sanitized.completed !== (row.completed ?? '') ||
      sanitized.next_steps !== (row.next_steps ?? '') ||
      sanitized.notes !== row.notes ||
      (sumFilesRead && newFr !== row.files_read) ||
      (sumFilesEdited && newFe !== row.files_edited);

    if (!changed) continue;
    sumWouldChange++;

    if (!execute) continue;

    if (sumFilesRead && sumFilesEdited) {
      db.prepare(`
        UPDATE session_summaries SET
          request = ?, investigated = ?, learned = ?, completed = ?,
          next_steps = ?, notes = ?, files_read = ?, files_edited = ?
        WHERE id = ?
      `).run(
        sanitized.request,
        sanitized.investigated,
        sanitized.learned,
        sanitized.completed,
        sanitized.next_steps,
        sanitized.notes,
        newFr ?? null,
        newFe ?? null,
        row.id
      );
    } else {
      db.prepare(`
        UPDATE session_summaries SET
          request = ?, investigated = ?, learned = ?, completed = ?,
          next_steps = ?, notes = ?
        WHERE id = ?
      `).run(
        sanitized.request,
        sanitized.investigated,
        sanitized.learned,
        sanitized.completed,
        sanitized.next_steps,
        sanitized.notes,
        row.id
      );
    }
    sumUpdated++;
  }

  db.close();

  console.log(`Database: ${dbPath}`);
  console.log(`Mode: ${execute ? 'EXECUTE (writes applied)' : 'DRY-RUN (no writes)'}`);
  console.log(`Observations: ${obsWouldChange} row(s) would change${execute ? `, ${obsUpdated} updated` : ''}`);
  console.log(`Session summaries: ${sumWouldChange} row(s) would change${execute ? `, ${sumUpdated} updated` : ''}`);
  if (!execute && (obsWouldChange > 0 || sumWouldChange > 0)) {
    console.log('\nRe-run with --execute to apply updates.');
  }
}

main();
