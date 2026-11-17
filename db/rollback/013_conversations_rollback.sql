-- ROLLBACK for migrations 013 (and 014). DESTRUCTIVE: it drops the conversation tables and every conversation, message and counter in them.
-- Run only on the developer's decision, on STAGING first. It never touches enquiries, store_knowledge, email_outbox or the AI budget tables, so
-- the legacy enquiry flow keeps working afterwards. If 014 was applied, the legacy enquiries are still intact (014 only copied them).
-- Before running: export anything you need (SELECT * FROM public.conversations / conversation_messages).
-- After running: the conversation checks in db/verify/013_conversations_checks.sql must fail (nothing left) and db/verify/012_assistant_checks.sql must pass.
DROP FUNCTION IF EXISTS public.conversation_purge_expired(integer, boolean);
DROP FUNCTION IF EXISTS public.conversation_delete(uuid, uuid);
DROP FUNCTION IF EXISTS public.conversation_seller_reply(uuid, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.conversation_finish_run(uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, jsonb);
DROP FUNCTION IF EXISTS public.conversation_post_message(uuid, uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.conversation_start(uuid, uuid, text, text, text, text, text, uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.conversation_begin_run(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.conversation_settle_ai(uuid, date, boolean);
DROP FUNCTION IF EXISTS public.conversation_reserve_ai(uuid);
DROP FUNCTION IF EXISTS public.conversation_take_customer_slot(uuid, text);
DROP FUNCTION IF EXISTS public.conversation_india_day();
DROP TABLE IF EXISTS public.conversation_messages;
DROP TABLE IF EXISTS public.conversation_usage;
DROP TABLE IF EXISTS public.conversations;
