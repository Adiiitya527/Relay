-- Fixture: the first statement succeeds, the second is a syntax error.
-- The whole file (including gadgets) must roll back and 002 must not be recorded.
CREATE TABLE gadgets (id integer PRIMARY KEY);
SELEC 1;
