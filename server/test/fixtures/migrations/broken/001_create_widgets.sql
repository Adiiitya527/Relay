-- Fixture: a valid first migration that must stay applied when 002 fails.
CREATE TABLE widgets (
  id    integer PRIMARY KEY,
  name  text NOT NULL
);
