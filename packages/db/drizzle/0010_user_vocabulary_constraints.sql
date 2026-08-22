-- A role, an interface language and a theme preference are three closed
-- vocabularies, and until now the database accepted any text at all in the
-- three columns that hold them. A row written by a script, a fixture or a
-- future bug could name a role nobody grants and a locale nobody translates,
-- and nothing would have said so at write time.
--
-- Written by hand, like every migration here. drizzle-kit produced the three
-- ALTER statements at the end; the block above them is the part that matters
-- and the part it cannot know to write.
--
-- No normalisation. Rewriting an unknown role to 'subscriber' would silently
-- change what an account can do, and rewriting it to 'administrator' would
-- silently grant everything; both are decisions for a person who can look at
-- the row and say which was meant. So this migration refuses instead, names
-- the rows it refuses over, and leaves the data exactly as it found it.

DO $$
DECLARE
  offenders text;
  total bigint;
BEGIN
  WITH invalid AS (
    SELECT id, field, value
    FROM "users",
         LATERAL (VALUES
           ('role', "role", "role" IN ('subscriber', 'contributor', 'author', 'editor', 'administrator')),
           ('locale', "locale", "locale" IN ('en', 'fr')),
           ('theme_preference', "theme_preference", "theme_preference" IN ('light', 'dark', 'system'))
         ) AS candidate(field, value, known)
    WHERE NOT known
  )
  SELECT
    (SELECT count(*) FROM invalid),
    -- Bounded twice: at most twenty rows listed, and at most forty characters
    -- of a stored value. A migration that fails should say enough to find the
    -- rows, not print the table into a deployment log.
    (SELECT string_agg(format('%s.%s = %L', id, field, left(value, 40)), E'\n  ' ORDER BY id, field)
     FROM (SELECT * FROM invalid ORDER BY id, field LIMIT 20) AS listed)
  INTO total, offenders;

  IF total > 0 THEN
    RAISE EXCEPTION
      'users hold % value(s) outside the known vocabularies', total
      USING DETAIL = format(
        E'Listing %s of %s:\n  %s',
        least(total, 20), total, offenders
      ),
      HINT = 'Correct each row to a known role, locale or theme preference, then run this migration again. Nothing was changed.';
  END IF;
END $$;--> statement-breakpoint

-- Added validated, not NOT VALID. The pair exists to attach a constraint under
-- a brief ACCESS EXCLUSIVE lock and do the scan later under a weaker one — but
-- the migrator runs this file inside one transaction, so every lock it takes is
-- held until commit either way, and the weaker lock buys nothing. The block
-- above has already read the same rows the scan will read.
ALTER TABLE "users" ADD CONSTRAINT "users_role_known" CHECK ("users"."role" in ('subscriber', 'contributor', 'author', 'editor', 'administrator'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_locale_known" CHECK ("users"."locale" in ('en', 'fr'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_theme_preference_known" CHECK ("users"."theme_preference" in ('light', 'dark', 'system'));
