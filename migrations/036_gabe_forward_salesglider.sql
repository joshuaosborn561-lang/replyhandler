-- Gabe Calls inbound forwards go to his SalesGlider address only (Josh, 2026-10-19).
UPDATE inbound_forward_rules
   SET to_emails = 'gabe@salesglidergrowth.com', updated_at = now()
 WHERE to_emails ILIKE '%gabriel.lopez@rocketbox.mx%';
