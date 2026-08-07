-- Slack "Meeting booked" button: stop follow-up cadence without DQ'ing the lead.

ALTER TABLE pending_replies
  DROP CONSTRAINT IF EXISTS pending_replies_status_check;

ALTER TABLE pending_replies
  ADD CONSTRAINT pending_replies_status_check
  CHECK (status IN (
    'pending', 'approved', 'rejected', 'sent', 'flagged',
    'alert_only', 'suppressed', 'disqualified', 'meeting_booked'
  ));
