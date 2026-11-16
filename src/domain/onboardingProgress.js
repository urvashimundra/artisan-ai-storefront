/** Where each onboarding step is completed. Steps 2 and 3 are idempotent, so the dashboard links straight back to them. */
export const STEP_LINKS = Object.freeze({
  contact: '/store/new/contact',
  languages: '/store/new/languages',
  languagesWithoutAi: '/store/settings',
  product: '/products/new',
});

/**
 * Builds the dashboard setup checklist from data the owner already has. No I/O.
 * @param {{ store: { whatsappNumber: string | null, whatsappEnabled: boolean },
 *   translationRows: { approved: boolean }[], productCount: number | null, canDraft: boolean }} data
 *   `productCount` is null when products are not available, which leaves that step out.
 * @returns {{ steps: { key: string, label: string, done: boolean, href: string | null }[], complete: boolean }}
 */
export function buildProgress({ store, translationRows, productCount, canDraft }) {
  const steps = [
    { key: 'shop', label: 'Shop created', done: true, href: null },
    {
      key: 'languages',
      label: 'Translations approved',
      done: translationRows.some((row) => row.approved),
      href: canDraft ? STEP_LINKS.languages : STEP_LINKS.languagesWithoutAi,
    },
    {
      key: 'whatsapp',
      label: 'WhatsApp set up',
      done: Boolean(store.whatsappNumber) && store.whatsappEnabled === true,
      href: STEP_LINKS.contact,
    },
  ];
  if (productCount !== null) steps.push({ key: 'product', label: 'First product added', done: productCount > 0, href: STEP_LINKS.product });
  return { steps, complete: steps.every((step) => step.done) };
}
