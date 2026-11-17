const PURGE_BATCH_SIZE = 200;
/** At most this many batches per run, so one cleanup never holds the worker for long; the next daily run continues. */
const MAX_BATCHES_PER_RUN = 5;

/**
 * Retention for customer chats: deletes conversations (messages, names, numbers, private-link material and any linked legacy enquiry) whose
 * last activity is more than 12 months old, through ONE database function (migration 013), in small batches. Legacy enquiries that were never
 * copied into conversations are NOT touched (that would change existing data and needs the developer's approval). It runs from the email
 * worker's daily cleanup, so it only runs while the app process is running; nothing else schedules it.
 * @param {{ conversations: { purgeExpired: (options: { limit: number, includeLegacy?: boolean }) => Promise<{ conversations: number, legacyEnquiries: number, usageRows: number }> },
 *   logger: { info: Function } }} deps
 * @returns {{ run: () => Promise<{ conversations: number, legacyEnquiries: number, usageRows: number }> }}
 */
export function createConversationRetention({ conversations, logger }) {
  return {
    /** Never throws away the caller's work: a database error propagates so the worker can log it. */
    async run() {
      const total = { conversations: 0, legacyEnquiries: 0, usageRows: 0 };
      for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
        const result = await conversations.purgeExpired({ limit: PURGE_BATCH_SIZE, includeLegacy: false });
        total.conversations += result.conversations;
        total.legacyEnquiries += result.legacyEnquiries;
        total.usageRows += result.usageRows;
        if (result.conversations < PURGE_BATCH_SIZE) break;
      }
      if (total.conversations + total.legacyEnquiries + total.usageRows > 0) logger.info('conversation retention run', total);
      return total;
    },
  };
}
