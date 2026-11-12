-- Fixture: takes longer than the statement_timeout the test tries to impose (A1).
SELECT pg_sleep(0.5);
