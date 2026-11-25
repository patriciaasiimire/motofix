-- Runs automatically on first Postgres container boot (docker-entrypoint-initdb.d).
-- Creates all MOTOFIX service databases if they do not already exist.
-- Each service owns its own database; schemas are managed by the service itself on startup.
-- Is just the setup script for the databases; tables and schemas are created by the services on startup.
-- The database engine and data are stored in the Compose volume mounted at /var/lib/postgresql.

SELECT 'CREATE DATABASE motofix_auth'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'motofix_auth')\gexec

SELECT 'CREATE DATABASE motofix_dispatch'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'motofix_dispatch')\gexec

SELECT 'CREATE DATABASE motofix_mechanics'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'motofix_mechanics')\gexec

SELECT 'CREATE DATABASE motofix_matching'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'motofix_matching')\gexec

SELECT 'CREATE DATABASE motofix_analytics'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'motofix_analytics')\gexec

SELECT 'CREATE DATABASE motofix_insurance'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'motofix_insurance')\gexec
