KAMPALA_SERVICE_AREAS = [
    (15, "Ntinda", "Kampala"),
    (19, "Nakawa", "Kampala"),
    (11, "Banda", "Kampala"),
    (16, "Naguru II", "Kampala"),
    (20, "Naguru I", "Kampala"),
    (22, "Industrial Area", "Kampala"),
    (54, "Kawempe I", "Kampala"),
    (38, "Kawempe II", "Kampala"),
    (57, "Bwaise I", "Kampala"),
    (56, "Bwaise II", "Kampala"),
    (52, "Bwaise III", "Kampala"),
    (75, "Nakulabye", "Kampala"),
    (80, "Wandegeya", "Kampala"),
    (60, "Makerere University", "Kampala"),
    (44, "Makerere I", "Kampala"),
    (61, "Mengo", "Kampala"),
    (47, "Kisenyi II", "Kampala"),
    (51, "Kasubi", "Kampala"),
]

KAMPALA_LAUNCH_MECHANICS = [
    ("Mr. Okumu", "256773833626", "Makerere", [60]),
    ("Benjamin", "256779410890", "Wandegeya", [80]),
    ("Waako Motors Limited", "256701752421", "Nakulabye via SS hotel", [75]),
    ("Kavuma", "256753011289", "Nakulabye", [75]),
    ("Kisamba Ashraf", "256708854388", "Mengo Kisenyi", [61, 47]),
    ("Julius", "256753109488", "Sir Apollo", [75]),
    ("Saka", "256752261936", "Total Maganjo", [54]),
    ("Muganga", "256701465998", "Kawempe", [54]),
    ("Faisal Mulindwa", "25677404699", "Kawempe", [54]),
    ("Japan", "256701778555", "Kawempe Referral hospital", [54]),
    ("Mayanja Isaac", "256701406346", "Kawempe", [54]),
    ("Kasule Juma", "256755834154", "Bwaise", [57]),
    ("Lwanga John", "256752661039", "Bwaise", [57]),
    ("Sam", "256782833922", "Naguru Go down", [16]),
    ("Ntinda Auto Center and Car Accessories", "256776533272", "Old Kira Road, Nakawa", [15, 19]),
    ("The Motor center", "256414233344", "Plot 16, Old Portbell Road, Industrial area", [22]),
    ("Kiviri", "256702671173", "Ntinda", [15]),
    ("Tonny", "256779222993", "Ntinda", [15]),
    ("Mechanic", "256750560093", "Wandegeya", [80]),
    ("Mwami Gerald", "256706201066", "Wandegeya", [80]),
    ("David Rapid motors", "256706324649", "Wandegeya", [80]),
    ("Musilamu", "256758144904", "Kireka", [11]),
    ("Paul", "256752423003", "Banda", [11]),
    ("Arnold", "256744355974", "Namungona", [51]),
    ("Contact 790714385", "256790714385", "Namungona", [51]),
]


async def ensure_launch_areas(conn) -> None:
    await conn.execute("""
        CREATE TABLE IF NOT EXISTS service_areas (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            zone TEXT
        )
    """)
    await conn.executemany("""
        INSERT INTO service_areas (id, name, zone)
        VALUES ($1, $2, $3)
        ON CONFLICT (id) DO UPDATE
        SET name = EXCLUDED.name, zone = EXCLUDED.zone
    """, KAMPALA_SERVICE_AREAS)

    area_type = await conn.fetchval("""
        SELECT udt_name FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'mechanics'
          AND column_name = 'service_area_ids'
    """)
    if area_type is None:
        await conn.execute("""
            ALTER TABLE mechanics
            ADD COLUMN service_area_ids INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[]
        """)
    elif area_type != "_int4":
        await conn.execute("""
            ALTER TABLE mechanics ADD COLUMN service_area_ids_migrated INTEGER[]
            NOT NULL DEFAULT ARRAY[]::INTEGER[]
        """)
        await conn.execute("""
            UPDATE mechanics
            SET service_area_ids_migrated = COALESCE((
                SELECT array_agg(area.id ORDER BY assigned.ordinal)
                FROM unnest(service_area_ids) WITH ORDINALITY AS assigned(value, ordinal)
                JOIN service_areas area
                  ON area.id::TEXT = trim(assigned.value)
                  OR lower(regexp_replace(area.name, '[^a-z0-9]+', '_', 'gi')) =
                     lower(regexp_replace(trim(assigned.value), '[^a-z0-9]+', '_', 'gi'))
                  OR area.id = CASE lower(trim(assigned.value))
                      WHEN 'ntinda' THEN 15
                      WHEN 'nakawa' THEN 19
                      WHEN 'banda' THEN 11
                      WHEN 'naguru' THEN 16
                      WHEN 'industrial_area' THEN 22
                      WHEN 'kawempe' THEN 54
                      WHEN 'bwaise' THEN 57
                      WHEN 'nakulabye' THEN 75
                      WHEN 'wandegeya' THEN 80
                      WHEN 'makerere' THEN 44
                      WHEN 'mengo' THEN 61
                      WHEN 'kisenyi_ii' THEN 47
                      WHEN 'kasubi' THEN 51
                      ELSE NULL
                  END
            ), ARRAY[]::INTEGER[])
        """)
        await conn.execute("ALTER TABLE mechanics DROP COLUMN service_area_ids")
        await conn.execute("""
            ALTER TABLE mechanics RENAME COLUMN service_area_ids_migrated TO service_area_ids
        """)
        await conn.execute("""
            ALTER TABLE mechanics ALTER COLUMN service_area_ids SET DEFAULT ARRAY[]::INTEGER[]
        """)
        await conn.execute("""
            ALTER TABLE mechanics ALTER COLUMN service_area_ids SET NOT NULL
        """)
