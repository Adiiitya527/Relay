-- Fixture: a migration long enough to be terminated while it runs (D69 test).
-- The test kills the backend within milliseconds, so the full sleep only runs if it fails.
SELECT pg_sleep(5);
