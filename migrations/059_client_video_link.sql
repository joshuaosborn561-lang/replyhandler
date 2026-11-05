-- Per-client video offer, same idea as booking_link.
-- The URL is not stored here. Set clients.video_link on the SalesGlider row
-- (dashboard) or SALESGLIDER_VIDEO_LINK when that column is empty.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS video_link TEXT;
