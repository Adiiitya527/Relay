-- Fixture: several statements in one file (runs via the simple query protocol).
ALTER TABLE widgets ADD COLUMN color text;
INSERT INTO widgets (id, name, color) VALUES (1, 'first', 'red');
