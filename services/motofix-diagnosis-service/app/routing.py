_COMPLEX_OR_UNSAFE_FAULTS = {
    "engine_failure",
    "brake_failure",
    "transmission_fault",
    "suspension_damage",
    "accident_damage",
    "overheating",
}
_ROADSIDE_FIRST_AID_FAULTS = {"tyre_puncture", "battery_dead", "fuel_issue"}


def apply_truthful_routing(data: dict) -> dict:
    """Enforce the assist-vs-tow contract after model output, not only in its prompt."""
    category = str(data.get("fault_category") or "other").strip().lower()
    severity = str(data.get("severity") or "medium").strip().lower()
    actions = list(data.get("recommended_actions") or [])

    if category == "accident_with_casualties":
        data["provider_type"] = "ambulance"
        data["severity"] = "critical"
        return data

    if severity in {"high", "critical"} or category in _COMPLEX_OR_UNSAFE_FAULTS:
        data["provider_type"] = "towing_provider"
        tow_action = "Do not drive the vehicle; request a tow to a proper garage or safer place."
        if not any("tow" in str(action).lower() for action in actions):
            actions.insert(0, tow_action)
        data["recommended_actions"] = actions
    elif category in _ROADSIDE_FIRST_AID_FAULTS and data.get("provider_type") != "spare_parts_dealer":
        data["provider_type"] = "mechanic"

    return data