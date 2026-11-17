import { AppError } from '../../src/lib/errors.js';
import { requireStoreId } from '../../src/repositories/requireStoreId.js';

/** In-memory knowledge repository with the real one's interface and rules: store-scoped, and replacing the document clears the tiers. */
export function createFakeKnowledgeRepo() {
  const rows = new Map();
  const calls = [];
  return {
    rows,
    calls,
    async get(storeId) {
      calls.push('get');
      const row = rows.get(requireStoreId(storeId));
      return row ? { content: row.content, bulkRules: structuredClone(row.bulkRules), updatedAt: row.updatedAt } : null;
    },
    async replaceContent(storeId, content, nowIso) {
      calls.push('replaceContent');
      rows.set(requireStoreId(storeId), { content, bulkRules: [], updatedAt: nowIso });
    },
    async saveRules(storeId, rules, nowIso) {
      calls.push('saveRules');
      const row = rows.get(requireStoreId(storeId)) ?? { content: '' };
      rows.set(storeId, { ...row, bulkRules: structuredClone(rules), updatedAt: nowIso });
    },
  };
}

/** A budget fake with the aiBudgetService interface: every reservation is recorded; `exhausted` makes reserve fail before any call. */
export function createFakeBudgets() {
  const budgets = {
    reservations: [],
    settled: [],
    released: [],
    exhausted: false,
    async reserve(request) {
      if (budgets.exhausted) throw new AppError('AI_BUDGET_EXHAUSTED', 429, 'Daily AI limit reached');
      const reservationId = `res-${budgets.reservations.length + 1}`;
      budgets.reservations.push({ reservationId, ...request });
      return { reservationId };
    },
    async settle(reservationId, costMicroUsd) {
      budgets.settled.push({ reservationId, costMicroUsd });
    },
    async release(reservationId) {
      budgets.released.push(reservationId);
    },
  };
  return budgets;
}
