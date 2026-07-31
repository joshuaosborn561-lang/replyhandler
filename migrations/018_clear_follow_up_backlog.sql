-- One-time: retire every follow-up queued before the runner existed.
--
-- outbound_follow_ups rows have been written on every send since the table was
-- created, but nothing ever read them, so they are all still 'pending' with a
-- due_at in the past. Follow-ups start clean from deploy onward — this clears
-- the backlog so no historical thread can be nudged.
--
-- Idempotent: reruns match nothing, because any row queued after this point is
-- either still pending with a future due_at or already resolved by the runner.
UPDATE outbound_follow_ups
   SET status = 'skipped',
       skip_reason = 'backlog_cleared',
       last_checked_at = now(),
       updated_at = now()
 WHERE status = 'pending'
   AND due_at <= now();
