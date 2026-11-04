-- Vector Energy Group (Al): prospect-facing link is the SalesGlider wrap.
-- The calendar behind it is his Cal.com page. The retired TidyCal
-- intro-call URL is not the booking link and not the destination.
-- Other clients are not updated. clients cannot be deleted.

UPDATE clients
   SET booking_link = 'https://book.gosalesglider.com/vector',
       booking_destination_url = 'https://cal.com/team/intro-call/vector-energy-group',
       updated_at = now()
 WHERE name ILIKE 'vector energy group'
   AND (
     booking_link IS DISTINCT FROM 'https://book.gosalesglider.com/vector'
     OR booking_destination_url IS DISTINCT FROM 'https://cal.com/team/intro-call/vector-energy-group'
   );
