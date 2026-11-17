-- Migration 014 (OPTIONAL): copy legacy enquiries into conversations so the seller's Conversations inbox shows them. Apply AFTER 013, and ONLY with
-- the developer's separate approval, on STAGING first. Idempotent: a legacy enquiry is copied at most once (conversations.legacy_enquiry_id is
-- unique), so running it again copies only enquiries that were not copied yet.
-- STATUS: written, NOT applied, NOT approved to run.
--
-- What it does: for every enquiry that is answered, needs_you or handled it inserts one conversation (same store, product, language, name, number,
-- token_hash and token_enc, so the private link keeps working: the app redirects /s/:slug/q/:token to the conversation), and its messages:
-- the question (customer), the assistant answer if any (assistant), and the seller reply if any (seller). Statuses: answered -> open,
-- needs_you -> needs_you (escalation_count 1), handled -> handled. pending and answering enquiries are SKIPPED (the old flow still owns them);
-- run it again later to copy them once they settle.
-- What it does NOT do: it never edits or deletes enquiries, never touches email_outbox (so email deduplication keys, which use the enquiry id,
-- are unchanged), never changes AI usage counters, and does not count against any customer or store limit.
-- Deleting the conversation later also deletes its linked legacy enquiry (conversation_delete), so personal data is removed in both places.

WITH legacy AS (
  SELECT e.*, (e.answer_text IS NOT NULL) AS has_answer, (e.seller_reply IS NOT NULL) AS has_reply
  FROM public.enquiries e
  WHERE e.status IN ('answered', 'needs_you', 'handled')
    AND NOT EXISTS (SELECT 1 FROM public.conversations c WHERE c.legacy_enquiry_id = e.id)
), new_conversations AS (
  INSERT INTO public.conversations
      (store_id, product_id, language, customer_name, customer_phone, status, flag_reason, token_hash, token_enc, start_key, message_count,
       last_message_role, last_preview, escalation_count, legacy_enquiry_id, last_activity_at, created_at, updated_at)
    SELECT l.store_id, l.product_id, l.language, l.customer_name, l.customer_phone,
           CASE l.status WHEN 'needs_you' THEN 'needs_you' WHEN 'handled' THEN 'handled' ELSE 'open' END,
           CASE WHEN l.status = 'needs_you' AND l.flag_reason IN ('not_in_document', 'budget', 'too_complex', 'unverified_amount') THEN l.flag_reason
                WHEN l.status = 'needs_you' AND l.flag_reason = 'daily_cap' THEN 'store_limit'
                WHEN l.status = 'needs_you' THEN 'unavailable' END,
           l.token_hash, l.token_enc, l.id,
           1 + (CASE WHEN l.has_answer THEN 1 ELSE 0 END) + (CASE WHEN l.has_reply THEN 1 ELSE 0 END),
           CASE WHEN l.has_reply THEN 'seller' WHEN l.has_answer THEN 'assistant' ELSE 'customer' END,
           left(coalesce(l.seller_reply, l.answer_text, l.question), 160),
           CASE WHEN l.status = 'needs_you' THEN 1 ELSE 0 END,
           l.id, greatest(l.updated_at, coalesce(l.replied_at, l.updated_at)), l.created_at, l.updated_at
    FROM legacy l
    RETURNING id, legacy_enquiry_id, store_id
), customer_messages AS (
  INSERT INTO public.conversation_messages (store_id, conversation_id, seq, role, body, created_at)
    SELECT n.store_id, n.id, 1, 'customer', l.question, l.created_at FROM new_conversations n JOIN legacy l ON l.id = n.legacy_enquiry_id
    RETURNING id
), assistant_messages AS (
  INSERT INTO public.conversation_messages (store_id, conversation_id, seq, role, body, created_at)
    SELECT n.store_id, n.id, 2, 'assistant', l.answer_text, coalesce(l.claimed_at, l.updated_at)
    FROM new_conversations n JOIN legacy l ON l.id = n.legacy_enquiry_id WHERE l.has_answer
    RETURNING id
)
INSERT INTO public.conversation_messages (store_id, conversation_id, seq, role, body, created_at)
  SELECT n.store_id, n.id, 2 + (CASE WHEN l.has_answer THEN 1 ELSE 0 END), 'seller', l.seller_reply, l.replied_at
  FROM new_conversations n JOIN legacy l ON l.id = n.legacy_enquiry_id WHERE l.has_reply;
