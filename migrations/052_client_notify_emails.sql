-- Client notification list (Josh, Oct 31 2026).
-- The automatic client emails this service sends (the weekday positive-reply
-- roll-up and the instant meeting-booked brief) and the manual
-- "Approve & Send + CC client" / Edit "CC client" choice read notify_emails.
-- cc_emails / cc_email stay the portal Always-notify list. They are not copied
-- onto Smartlead or HeyReach prospect sends.
-- Copies the current always-forward list once. A later edit of cc_emails does
-- not overwrite a notification list that is already set.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS notify_emails TEXT;

UPDATE clients
   SET notify_emails = btrim(cc_emails)
 WHERE (notify_emails IS NULL OR btrim(notify_emails) = '')
   AND cc_emails IS NOT NULL
   AND btrim(cc_emails) <> '';
