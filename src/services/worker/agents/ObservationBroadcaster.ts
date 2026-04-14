/**
 * ObservationBroadcaster: SSE broadcasting for observations and summaries
 *
 * Responsibility:
 * - Broadcast new observations to SSE clients
 * - Broadcast new summaries to SSE clients
 * - Handle worker reference safely (null checks)
 *
 * BUGFIX: This module fixes the incorrect field names in SDKAgent:
 * - SDKAgent used `obs.files` which doesn't exist - should be `obs.files_read`
 * - SDKAgent used hardcoded `files_modified: JSON.stringify([])` - should use `obs.files_modified`
 */

import type { WorkerRef, ObservationSSEPayload, SummarySSEPayload } from './types.js';
import { logger } from '../../../utils/logger.js';
import { OBSERVER_SESSIONS_PROJECT } from '../../../shared/paths.js';

/**
 * Broadcast a new observation to SSE clients
 *
 * @param worker - Worker reference with SSE broadcaster (can be undefined)
 * @param payload - Observation data to broadcast
 */
export function broadcastObservation(
  worker: WorkerRef | undefined,
  payload: ObservationSSEPayload
): void {
  if (!worker?.sseBroadcaster) {
    return;
  }

  // Don't broadcast observer-session observations to the viewer UI
  if (payload.project === OBSERVER_SESSIONS_PROJECT) {
    return;
  }

  worker.sseBroadcaster.broadcast({
    type: 'new_observation',
    observation: payload
  });
}

/**
 * Broadcast a new summary to SSE clients
 *
 * @param worker - Worker reference with SSE broadcaster (can be undefined)
 * @param payload - Summary data to broadcast
 */
export function broadcastSummary(
  worker: WorkerRef | undefined,
  payload: SummarySSEPayload
): void {
  if (!worker?.sseBroadcaster) {
    return;
  }

  // Don't broadcast observer-session summaries to the viewer UI
  if (payload.project === OBSERVER_SESSIONS_PROJECT) {
    return;
  }

  worker.sseBroadcaster.broadcast({
    type: 'new_summary',
    summary: payload
  });
}
