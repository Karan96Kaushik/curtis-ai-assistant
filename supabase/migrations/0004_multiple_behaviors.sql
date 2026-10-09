-- A user can keep more than one behavior context. Save behavior folds into
-- an existing title or inserts a new row. Reference contexts are unchanged.

drop index if exists public.contexts_one_behavior_idx;
