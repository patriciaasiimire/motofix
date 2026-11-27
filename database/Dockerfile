FROM postgres:18-alpine

# Include the setup script in the image so Compose does not rely on a host bind mount.
COPY init-databases.sql /docker-entrypoint-initdb.d/10-init-databases.sql
