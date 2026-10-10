from app.launch_data import KAMPALA_LAUNCH_MECHANICS, KAMPALA_SERVICE_AREAS
from app.routers.auth import RegisterRequest


def test_kampala_launch_seed_has_stable_areas_and_unique_phones():
    area_ids = {area_id for area_id, _, _ in KAMPALA_SERVICE_AREAS}
    phones = [phone for _, phone, _, _ in KAMPALA_LAUNCH_MECHANICS]

    assert len(KAMPALA_LAUNCH_MECHANICS) == 25
    assert area_ids == set(range(1, 100))
    assert len(phones) == len(set(phones))
    assert {15, 19, 11, 16, 20, 22, 54, 38, 57, 56, 52, 75, 80, 60, 44, 61, 47, 51} <= area_ids
    assert all(set(mechanic_areas) <= area_ids for _, _, _, mechanic_areas in KAMPALA_LAUNCH_MECHANICS)


def test_registration_accepts_name_and_area_membership_without_coordinates():
    mechanic = RegisterRequest(
        name="Area-only mechanic",
        phone="256700000001",
        location="Ntinda",
        service_area_ids=[15],
    )

    assert mechanic.name == "Area-only mechanic"
    assert mechanic.service_area_ids == [15]
