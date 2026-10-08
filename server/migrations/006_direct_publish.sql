UPDATE works SET status='approved',reason='',updated_at=now() WHERE status='pending';
UPDATE works SET status='draft',updated_at=now() WHERE status='rejected';
UPDATE competition SET data=jsonb_set(data,'{rules}',to_jsonb(replace(replace(data->>'rules','作品审核通过后进入展区','作品发布后直接进入展区'),'违规票经审核后作废','违规票经核实后作废'))) WHERE id=1;
