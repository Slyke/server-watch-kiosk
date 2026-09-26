-- Disposable lab schema; the board role can only read.
CREATE ROLE board_reader LOGIN PASSWORD 'reader-lab-only';
CREATE TABLE service_heartbeats (service text PRIMARY KEY, last_success_at timestamptz NOT NULL);
INSERT INTO service_heartbeats VALUES ('demo-import', now());
GRANT CONNECT ON DATABASE board_lab TO board_reader;
GRANT USAGE ON SCHEMA public TO board_reader;
GRANT SELECT ON service_heartbeats TO board_reader;
