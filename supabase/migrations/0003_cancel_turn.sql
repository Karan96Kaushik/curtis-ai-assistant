-- Lets the browser stop a turn that is still calling Groq. The chat function
-- watches this and aborts the in-flight completion when it matches the turn id.
alter table public.conversations
  add column cancel_turn_id text check (cancel_turn_id is null or char_length(cancel_turn_id) <= 80);
