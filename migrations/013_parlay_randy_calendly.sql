-- Parlay Tech: replace TidyCal with Randy Haba's Calendly link.
UPDATE clients
   SET booking_link = 'https://calendly.com/randyhaba/30min',
       updated_at = now()
 WHERE id = '9760132c-1dd3-4e97-8f29-c5d4d01f5054'
    OR (LOWER(name) LIKE '%parlay%' AND booking_link LIKE '%tidycal.com%');
