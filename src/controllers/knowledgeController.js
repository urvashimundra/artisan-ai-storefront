import { ZodError } from 'zod';
import { MAX_KNOWLEDGE_LENGTH, MAX_BULK_TIERS, rulesFormValues, tierRowNumbers } from '../domain/knowledgeRules.js';
import { AppError } from '../lib/errors.js';
import { echoValues, fieldErrors } from './formErrors.js';

const SEE_OTHER = 303;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const KNOWLEDGE_PATH = '/store/knowledge';
const ONBOARDING_STEP = '4';
const ONBOARDING_DONE_PATH = '/dashboard?welcome=1';
const RAW_FIELD_FACTOR = 4;
const RULE_FIELDS = tierRowNumbers().flatMap((row) => [`minQty${row}`, `percentOff${row}`]);
const NOTICES = {
  document: 'Your shop notes were saved.',
  documentCleared: 'Your shop notes were saved. Your bulk discounts were cleared because the notes changed. Check them and save them again.',
  rules: 'Your bulk discounts were saved. The assistant will use only these.',
};
const DOCUMENT_ERROR = `Your notes can be up to ${MAX_KNOWLEDGE_LENGTH} characters.`;
const RULES_ERROR = `Enter up to ${MAX_BULK_TIERS} discounts. Each needs 2 to 1000 items and 1 to 50 percent, and the number of items must go up from one row to the next.`;

/**
 * Owner page for the shop knowledge document and the bulk discounts. The store comes from the session (`req.store`), the owner from
 * `req.owner`; neither is read from the request. The strict schemas reject a store id in the body. `?step=4` marks the optional
 * onboarding step: saving or skipping there ends on the welcome dashboard.
 * @param {{ knowledge: ReturnType<import('../services/knowledgeService.js').createKnowledgeService> }} deps
 */
export function createKnowledgeController({ knowledge }) {
  const isStep = (req) => req.query?.step === ONBOARDING_STEP;
  const stepSuffix = (req) => (isStep(req) ? `?step=${ONBOARDING_STEP}` : '');

  async function page(req, res, status, view = {}) {
    const saved = await knowledge.get(req.store);
    return res.status(status).render('store-knowledge', {
      title: 'Shop notes for the assistant',
      onboarding: isStep(req),
      stepSuffix: stepSuffix(req),
      content: view.content ?? saved.content,
      ruleValues: view.ruleValues ?? rulesFormValues(saved.rules),
      ruleRows: tierRowNumbers(),
      confirmedRules: saved.rules,
      documentError: view.documentError ?? null,
      rulesError: view.rulesError ?? null,
      aiError: view.aiError ?? null,
      notice: view.notice ?? null,
      canExtract: knowledge.canExtract,
      hasDocument: saved.content.trim() !== '',
      maxLength: MAX_KNOWLEDGE_LENGTH,
    });
  }

  return {
    show(req, res) {
      return page(req, res, HTTP_OK, { notice: NOTICES[req.query?.saved] ?? null });
    },

    async saveDocument(req, res) {
      let outcome;
      try {
        outcome = await knowledge.saveDocument(req.store, req.body);
      } catch (error) {
        if (!(error instanceof ZodError)) throw error;
        fieldErrors(error, {});
        const content = echoValues(req.body, ['content'], MAX_KNOWLEDGE_LENGTH * RAW_FIELD_FACTOR).content ?? '';
        return page(req, res, HTTP_BAD_REQUEST, { content, documentError: DOCUMENT_ERROR });
      }
      if (isStep(req)) return res.redirect(SEE_OTHER, ONBOARDING_DONE_PATH);
      return res.redirect(SEE_OTHER, `${KNOWLEDGE_PATH}?saved=${outcome.clearedRules ? 'documentCleared' : 'document'}`);
    },

    async saveRules(req, res) {
      try {
        await knowledge.saveRules(req.store, req.body);
      } catch (error) {
        if (!(error instanceof ZodError)) throw error;
        fieldErrors(error, {});
        return page(req, res, HTTP_BAD_REQUEST, { ruleValues: echoValues(req.body, RULE_FIELDS, 10), rulesError: RULES_ERROR });
      }
      return res.redirect(SEE_OTHER, `${KNOWLEDGE_PATH}${stepSuffix(req) ? `${stepSuffix(req)}&` : '?'}saved=rules`);
    },

    /** Asks Claude to PROPOSE tiers. They only fill the editable form; nothing is saved or used until the owner saves. */
    async findRules(req, res) {
      let tiers;
      try {
        tiers = await knowledge.findBulkRules({ store: req.store, owner: req.owner, correlationId: req.correlationId });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        return page(req, res, error.httpStatus, { aiError: error.message });
      }
      const notice = tiers.length > 0
        ? `Claude found ${tiers.length} bulk discount${tiers.length === 1 ? '' : 's'} in your notes. Check them and press Save bulk discounts. Nothing is used until you save.`
        : 'Claude did not find a clear bulk discount in your notes. You can enter one yourself.';
      return page(req, res, HTTP_OK, { ruleValues: rulesFormValues(tiers), notice });
    },
  };
}
