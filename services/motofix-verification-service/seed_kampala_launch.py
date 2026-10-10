"""Idempotently seed the stable Kampala launch areas and mechanics.

Run from this service directory with: python seed_kampala_launch.py
Existing credentials/passwords are preserved; mechanic rows are upserted by phone.
"""

import asyncio
import os

import asyncpg
from dotenv import load_dotenv

from app.launch_data import (
    KAMPALA_LAUNCH_MECHANICS,
    KAMPALA_SERVICE_AREAS,
    ensure_launch_areas,
)


async def seed() -> None:
    load_dotenv()
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is required to seed Kampala launch mechanics")

    conn = await asyncpg.connect(database_url)
    try:
        async with conn.transaction():
            for statement in (
                "ALTER TABLE mechanics ADD COLUMN IF NOT EXISTS name TEXT",
                "ALTER TABLE mechanics ADD COLUMN IF NOT EXISTS location TEXT",
                "ALTER TABLE mechanics ADD COLUMN IF NOT EXISTS password_hash TEXT",
                "ALTER TABLE mechanics ADD COLUMN IF NOT EXISTS specialty TEXT DEFAULT 'General Repair'",
                "ALTER TABLE mechanics ADD COLUMN IF NOT EXISTS vehicle_type TEXT DEFAULT 'car'",
                "ALTER TABLE mechanics ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT false",
                "ALTER TABLE mechanics ADD COLUMN IF NOT EXISTS is_available BOOLEAN DEFAULT true",
                "ALTER TABLE mechanics ADD COLUMN IF NOT EXISTS total_ratings INTEGER DEFAULT 0",
                "ALTER TABLE mechanics ADD COLUMN IF NOT EXISTS jobs_completed INTEGER DEFAULT 0",
                "ALTER TABLE mechanics ADD COLUMN IF NOT EXISTS fcm_token TEXT",
                "ALTER TABLE mechanics ADD COLUMN IF NOT EXISTS latitude FLOAT",
                "ALTER TABLE mechanics ADD COLUMN IF NOT EXISTS longitude FLOAT",
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_mechanics_phone_unique ON mechanics(phone)",
                "ALTER TABLE mechanics ALTER COLUMN location DROP NOT NULL",
                "ALTER TABLE mechanics ALTER COLUMN latitude DROP NOT NULL",
                "ALTER TABLE mechanics ALTER COLUMN longitude DROP NOT NULL",
            ):
                await conn.execute(statement)

            await conn.execute("""
                DO $$
                BEGIN
                    IF EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_schema = current_schema()
                          AND table_name = 'mechanics'
                          AND column_name = 'full_name'
                    ) THEN
                        EXECUTE format(
                            'UPDATE mechanics SET name = COALESCE(NULLIF(name, %L), full_name) WHERE full_name IS NOT NULL',
                            ''
                        );
                        ALTER TABLE mechanics ALTER COLUMN full_name DROP NOT NULL;
                    END IF;
                END $$
            """)
            await ensure_launch_areas(conn)

            for name, phone, location, area_ids in KAMPALA_LAUNCH_MECHANICS:
                await conn.execute("""
                    INSERT INTO mechanics (
                        name, phone, location, specialty, vehicle_type,
                        service_area_ids, is_verified, is_available, latitude, longitude
                    )
                    VALUES ($1, $2, $3, 'General Repair', 'car', $4, true, true, NULL, NULL)
                    ON CONFLICT (phone) DO UPDATE SET
                        name = EXCLUDED.name,
                        location = EXCLUDED.location,
                        service_area_ids = EXCLUDED.service_area_ids,
                        is_verified = true,
                        is_available = true,
                        latitude = NULL,
                        longitude = NULL
                """, name, phone, location, area_ids)

            count = await conn.fetchval("""
                SELECT count(*) FROM mechanics
                WHERE phone = ANY($1::text[])
                  AND is_verified = true AND is_available = true
                  AND latitude IS NULL AND longitude IS NULL
            """, [phone for _, phone, _, _ in KAMPALA_LAUNCH_MECHANICS])
            area_count = await conn.fetchval("""
                SELECT count(*) FROM service_areas WHERE id = ANY($1::INTEGER[])
            """, [area_id for area_id, _, _ in KAMPALA_SERVICE_AREAS])
            if count != len(KAMPALA_LAUNCH_MECHANICS):
                raise RuntimeError(
                    f"Expected {len(KAMPALA_LAUNCH_MECHANICS)} eligible seed mechanics; found {count}"
                )
            if area_count != 18:
                raise RuntimeError(f"Expected 18 Kampala launch service areas; found {area_count}")
        print(f"Seeded/updated {count} verified, available mechanics and {area_count} launch areas.")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(seed())
