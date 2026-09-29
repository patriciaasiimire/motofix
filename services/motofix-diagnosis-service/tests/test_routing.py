from app.routing import apply_truthful_routing


def test_classic_roadside_fault_routes_to_mechanic():
    diagnosis = apply_truthful_routing({
        "fault_category": "tyre_puncture",
        "severity": "medium",
        "provider_type": "towing_provider",
        "recommended_actions": ["Stay clear of traffic."],
    })

    assert diagnosis["provider_type"] == "mechanic"


def test_high_severity_or_complex_fault_routes_to_tow():
    diagnosis = apply_truthful_routing({
        "fault_category": "electrical_fault",
        "severity": "high",
        "provider_type": "mechanic",
        "recommended_actions": ["Switch off the engine."],
    })

    assert diagnosis["provider_type"] == "towing_provider"
    assert any("tow" in action.lower() for action in diagnosis["recommended_actions"])


def test_casualties_route_to_ambulance_not_tow():
    diagnosis = apply_truthful_routing({
        "fault_category": "accident_with_casualties",
        "severity": "high",
        "provider_type": "towing_provider",
        "recommended_actions": ["Call emergency services."],
    })

    assert diagnosis["provider_type"] == "ambulance"
    assert diagnosis["severity"] == "critical"