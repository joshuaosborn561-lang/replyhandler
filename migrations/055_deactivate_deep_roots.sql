-- Deactivate Deep Roots (Josh, Oct 31 2026).
-- Do not DELETE the row. clients is protected from DELETE / TRUNCATE, and
-- several child foreign keys have no ON DELETE CASCADE, so a hard delete
-- fails or would take related rows with it.
-- This does not change Smartlead, inboxes, or HubSpot.

UPDATE clients
   SET active = false,
       updated_at = now()
 WHERE name ILIKE 'deep roots%'
   AND active IS DISTINCT FROM false;
