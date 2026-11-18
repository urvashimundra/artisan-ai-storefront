# Skipped redesign items

| Task | Item | Reason |
| --- | --- | --- |
| T2 | Audit §5.4 duplicate list | Audit file is not in the repo; duplicates were found by inspection (.button-danger, .danger-zone and its summary, .plain). Check the audit list for any others. |
| T4 | aria-current="page" | No current-page local or request data is passed to the views; needs a controller or middleware change. |
| All | @layer | Out of scope for this pass. |
| T6 | city + state pair | No city or state fields exist in the T6 templates; WhatsApp + Instagram paired instead. |
| T8 | Translation error handling | Needs controller change; skipped as instructed. Form widths at 1280 not measured in a browser (preview server cannot mount /store/settings); covered by a selector test instead. |
| T9 | e) Generate again confirm | confirm-submit.js supports submit buttons in form[data-confirm], but product-generate.js (data-progress) disables the buttons in its own submit handler without checking defaultPrevented, so a cancelled confirm would leave the form stuck. Needs a JS change. |
| T9 | Product thumbnails in products.ejs | Needs a service change. products.ejs left unchanged. |
| T9 | Form width at 1280 | Not measured in a browser (preview server cannot mount /products/:id/edit); template nesting pinned by a test instead. |
| T10 | .product-photo merge | Equivalent, but tests/unit/storefrontGrid.test.js pins margin-bottom: 1rem from the first (dead) block; existing tests may not be weakened, so the two blocks stay. |
| T11 | Product card "one clear action" | The whole card is already one link (href unchanged). A separate visible action label needs a new translated string in the strings module (service change), so none was added. |
| T11 | Instagram icon | No Instagram icon partial exists; none was created (partials must not be recreated). Instagram link stays text-only. |
| T12 | Quantity and checkout form on the product page | The product page has no form: it links to /buy, where the quantity field and checkout form live. Those were left unchanged (pinned by a test). |
| T14 | Q9 separate payment status | Status and payment status are ONE domain field (`order.status`: awaiting_payment, payment_submitted, paid, not_received, cancelled). The header badge and the Payment card both render `order.statusLabel`, so they always match. No field or state was added; the template label "Payment status" was changed to "Current status" so it no longer implies a second value. |
