-- The site's own sign-in sessions (Nov 24). Until now the page sent Google's ID token with every request, and those
-- last an hour: renewing one quietly (Google One Tap) often fails, and on an iPhone home-screen app it never tries, so
-- members were asked to sign in again every hour or so. Now Google is asked once: the API checks its token, starts a
-- session here, and the browser keeps the session in an HttpOnly cookie (the page's scripts can't read it).
--   * Only a SHA-256 hash of each session token is stored, so a copy of this table can't be used to sign in.
--   * A session ends after `days` without use (60 in the API); using it pushes that out, at most once a day.
--   * Signing out ends it here. Being removed from the invite list ends access at once anyway: every request still
--     goes through bgc.sign_in (the API remembers that answer for a minute).
--   * At most 20 sessions per email (one per browser or device); starting a 21st ends the oldest.
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 061_sessions.sql  (or bash apply.sh)
BEGIN;

CREATE TABLE IF NOT EXISTS sessions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash  text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  email       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  used_at     timestamptz NOT NULL DEFAULT now(),
  renewed_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_email ON sessions (email, created_at);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at);

-- A new session for someone the API has just checked with Google (and found on the invite list)
CREATE OR REPLACE FUNCTION bgc.session_start(email text, hash text, days int) RETURNS void LANGUAGE plpgsql AS $$
DECLARE e text := lower(trim(email));
BEGIN
  DELETE FROM sessions WHERE expires_at < now();
  INSERT INTO sessions (token_hash, email, expires_at) VALUES (hash, e, now() + make_interval(days => days));
  DELETE FROM sessions WHERE id IN (SELECT id FROM sessions s WHERE s.email = e ORDER BY created_at DESC, id DESC OFFSET 20);
END $$;

-- Whose session this is, or null when there's none (never started, signed out, or expired). renewed: the session was
-- just pushed out to `days` from now, so the API sends the cookie again with the new lifetime.
CREATE OR REPLACE FUNCTION bgc.session_check(hash text, days int) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE s sessions; renew boolean;
BEGIN
  SELECT * INTO s FROM sessions WHERE token_hash = hash AND expires_at > now();
  IF NOT FOUND THEN RETURN NULL; END IF;
  renew := s.renewed_at < now() - interval '1 day';
  IF renew OR s.used_at < now() - interval '5 minutes' THEN
    UPDATE sessions SET used_at = now(),
      renewed_at = CASE WHEN renew THEN now() ELSE renewed_at END,
      expires_at = CASE WHEN renew THEN now() + make_interval(days => days) ELSE expires_at END
    WHERE id = s.id;
  END IF;
  RETURN jsonb_build_object('email', s.email, 'renewed', renew);
END $$;

-- Signing out
CREATE OR REPLACE FUNCTION bgc.session_end(hash text) RETURNS void LANGUAGE sql AS $$
  DELETE FROM sessions WHERE token_hash = hash;
$$;

COMMIT;
