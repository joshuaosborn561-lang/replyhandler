-- Regular calendar URL Josh pasted (Calendly / HubSpot / Teams / SavvyCal).
-- booking_link is rewritten to the BookingBridge wrap; this column keeps
-- the public destination so we can read open times.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS booking_destination_url TEXT;
