"""
AI diagnosis logic — this is the "brain" behind MOTOBOT and the auto-diagnosis features.

Everything here talks to an AI model and turns the reply into something our app can use.
We use TWO different AI providers, each for what it's best at:

  - Claude (Anthropic)  → fault diagnosis from text or a photo, and the MOTOBOT chat.
                          These need careful judgement, so we use the stronger model.
  - Groq (Llama models) → faster/cheaper helpers: the step-by-step question flow,
                          spare-parts pricing, the fuel advisor, voice-note transcription,
                          and the rotating home-screen greetings.

How most functions work, in three steps:
  1. Build a "system prompt" (the big triple-quoted strings below) telling the AI exactly
     how to behave and what JSON shape to return.
  2. Send it the driver's input and get a reply.
  3. Parse the reply (usually JSON) into a tidy result. If anything fails, we return a
     safe "fallback" so the app never crashes just because the AI is unavailable.
"""

import base64
import json
import logging
import os
import re
from typing import List, Optional

from anthropic import AsyncAnthropic
from groq import AsyncGroq

from .schemas import ChatMessage, ChatResponse, DiagnosisResult
from .routing import apply_truthful_routing

logger = logging.getLogger(__name__)

# ── Claude (Anthropic) client — powers text + image fault diagnosis ─────────────
CLAUDE_MODEL = "claude-haiku-4-5"
_ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")
_anthropic: Optional[AsyncAnthropic] = (
    AsyncAnthropic(api_key=_ANTHROPIC_API_KEY) if _ANTHROPIC_API_KEY else None
)


def _claude_text(resp) -> str:
    """Concatenate the text blocks of a Claude Messages response."""
    return "".join(
        getattr(b, "text", "") for b in resp.content if getattr(b, "type", "") == "text"
    ).strip()


def _extract_json(text: str) -> str:
    """Pull the JSON object out of a model reply (handles ``` fences / stray prose)."""
    t = text.strip()
    if t.startswith("```"):
        t = re.sub(r"^```(?:json)?\s*", "", t)
        t = re.sub(r"\s*```$", "", t).strip()
    start, end = t.find("{"), t.rfind("}")
    if start != -1 and end != -1 and end > start:
        return t[start : end + 1]
    return t


def _diagnosis_fallback(image: bool = False) -> DiagnosisResult:
    """Safe default when the AI is unavailable or returns something unparseable."""
    return DiagnosisResult(
        fault_category="other",
        fault_description=(
            "Could not analyse the image — please describe the fault in the chat."
            if image
            else "Automatic classification unavailable — a provider will assess on site and recommend a tow if roadside work is unsafe."
        ),
        provider_type="mechanic",
        severity="medium",
        confidence=0.0,
        recommended_actions=(
            ["Describe your vehicle issue in text for better assistance"]
            if image
            else ["Stay in a safe location away from traffic", "Wait for assistance"]
        ),
        follow_up_questions=None,
    )


def _chat_fallback(reply: str = "I'm having trouble connecting right now. Please describe your vehicle problem briefly and we'll send the right help.") -> ChatResponse:
    return ChatResponse(reply=reply, diagnosis_ready=False, diagnosis=None)


def _as_claude_msgs(messages: List[ChatMessage]) -> list:
    """ChatMessage[] → Claude messages; drop leading non-user turns (Claude needs messages[0] == user)."""
    msgs = [{"role": m.role, "content": m.content} for m in messages]
    while msgs and msgs[0]["role"] != "user":
        msgs.pop(0)
    return msgs

# ── System prompts ────────────────────────────────────────────────────────────

_DIAGNOSIS_SYSTEM_PROMPT = """You are an expert automotive fault diagnosis engine for MOTOFIX, a roadside assistance platform in Uganda.

Analyse the vehicle fault input and respond ONLY with valid JSON matching this exact structure (no extra text):
{
  "fault_category": "<category>",
  "fault_description": "<brief technical description in plain English>",
  "provider_type": "<mechanic|towing_provider|spare_parts_dealer>",
  "severity": "<low|medium|high|critical>",
  "confidence": <float 0.0-1.0>,
  "recommended_actions": ["<action1>", "<action2>"],
  "follow_up_questions": ["<question if more info is needed — omit array if none>"],
  "required_parts": [{"name": "<part>", "price_min": <UGX int>, "price_max": <UGX int>}],
  "service_fee_min": <UGX int>,
  "service_fee_max": <UGX int>,
  "repair_fee_min": <UGX int>,
  "repair_fee_max": <UGX int>
}

Spare-parts guidance (required_parts, service_fee_min, service_fee_max):
  Fill these in whenever the fault typically needs the driver to BUY a part to fix it
  (e.g. tyre_puncture, battery_dead, brake_failure, electrical_fault, fuel_issue,
  overheating, suspension_damage). List the common part(s) needed with realistic
  Ugandan price ranges in UGX, and the typical fitting/labour fee a roadside
  mechanic charges. If the fault does NOT involve buying a part (e.g. out of fuel,
  accident with casualties), set required_parts to [] and omit the service_fee fields.
  Use whole UGX numbers, no commas or currency symbols. Be realistic for Uganda 2025
  (e.g. a saloon tube ~15000-35000, a small car battery ~250000-450000,
  brake pads ~80000-200000). These are rough public estimates, not a binding quote.

Repair-vs-replace transparency (repair_fee_min, repair_fee_max):
  Many faults can OFTEN be fixed on the spot WITHOUT buying a new part — estimate
  the typical cost of that minor fix (labour + small consumables only), which is
  much cheaper than replacement. Examples: tyre puncture patch/plug ~5000-20000;
  dead battery jump-start or recharge ~10000-40000; loose/corroded terminal clean
  & tighten ~5000-15000; bleed/adjust brakes ~20000-60000; reconnect/secure a
  loose part ~5000-25000. If the fault truly cannot be repaired and ALWAYS needs a
  new part, set both repair_fee fields to 0. The mechanic confirms which applies
  after a quick inspection — so the driver isn't forced to buy new if a repair works.

Fault categories:
  engine_failure, tyre_puncture, battery_dead, overheating, brake_failure,
  electrical_fault, fuel_issue, transmission_fault, suspension_damage,
  accident_damage, accident_with_casualties, other

CRITICAL RULE: If the fault involves injured people, bleeding, unconscious persons,
or any medical emergency — set fault_category to "accident_with_casualties",
provider_type to "ambulance", and severity to "critical". Never recommend a
towing_provider when people are hurt.

Provider type rules:
    mechanic           — roadside assist / first aid: tyre puncture, battery jump, minor safe fix.
                                             The mechanic triages on the road; do not promise a full repair there.
    towing_provider    — vehicle cannot or should not be moved under its own power, or the fault
                                             is complex/high-risk and belongs in a garage (e.g. engine seizure,
                                             serious accident damage, brake failure, major overheating).
                                             Recommend a tow to a proper garage or safer place when this is likely.
  spare_parts_dealer — driver needs a specific part and can install it themselves
  ambulance          — there are injured people, someone is bleeding, unconscious, or in medical
                       danger as a result of a road incident. ALWAYS use this when any person
                       is hurt — do NOT use towing_provider for accidents with casualties.

Severity rules:
  low      — cosmetic or convenience issue, not time-sensitive
  medium   — should be attended to within a few hours, minor safety concern
    high     — needs attention immediately; prefer tow when roadside work may be unsafe
    critical — dangerous, do not drive; require immediate tow (ambulance if anyone is hurt)

Product promise: MOTOFIX gets the right help fast — fix it on the spot if safe and practical,
or get the vehicle to a proper garage if it cannot be repaired safely on the road.

Uganda context: most vehicles are boda-bodas (motorcycles), saloon cars, or minibus taxis (matatus).
Common faults: tyre punctures, battery issues, overheating, fuel problems."""

# ── Fuel advisor prompt ───────────────────────────────────────────────────────

_FUEL_ADVISOR_PROMPT = """You are a fuel and engine compatibility expert for MOTOFIX, a roadside assistance platform in Uganda.

Driver's car: {car_model}
Selected fuel type: {fuel_type}

Uganda vehicle fleet — engine types by model:
• Toyota Ipsum (2.0–2.4L 2AZ-FE): petrol_standard
• Toyota Corolla (1.5L 1NZ-FE / 1.8L 1ZZ-FE / 2ZR-FE): petrol_standard
• Toyota Premio / Allion (1.5L 1NZ-FE / 2.0L 1AZ-FE): petrol_standard
• Toyota Wish (1.8L 1ZZ-FE / 2ZR-FE): petrol_standard
• Toyota Harrier (2.4L 2AZ-FE / 3.0L 1MZ-FE): petrol_standard
• Toyota RAV4 (2.0L 1AZ-FE petrol / 2.2L 2AD-FHV diesel): petrol_standard or diesel by variant
• Toyota Prado 120/150 (3.0L 1KD-FTV diesel / 4.0L 1GR-FE petrol): diesel or petrol by variant
• Toyota Land Cruiser (4.2L 1HD / 4.5L 1VD diesel): diesel
• Toyota Hilux (2.5L 2KD-FTV / 2.8L 1GD-FTV diesel): diesel
• Toyota Hiace (2.5L 2KD-FTV diesel): diesel
• Toyota Fortuner (2.7L 2TR-FE petrol / 2.8L 1GD-FTV diesel): check variant
• Nissan X-Trail (2.0L MR20 petrol / 2.2L YD22 diesel): check variant
• Nissan Note (1.2L HR12DE): petrol_standard
• Nissan Sylphy / Bluebird Sylphy (1.5L–2.0L): petrol_standard
• Honda CRV (2.0L K20A / 2.4L K24A): petrol_standard
• Honda Fit / Jazz (1.3L L13A / 1.5L L15A): petrol_standard
• Honda Freed (1.5L L15A): petrol_standard
• Subaru Forester (2.0L EJ20 turbo / 2.5L EJ25): petrol_turbo
• Subaru Outback (2.5L EJ25): petrol_standard (non-turbo variants) or petrol_turbo
• Subaru Impreza / WRX: petrol_turbo
• Mitsubishi Pajero (3.5L 6G72 V6 petrol / 3.2L 4M41 diesel): check variant
• Mitsubishi L200 / Triton (2.5L 4D56 diesel): diesel
• VW Golf (1.4L TSI turbo petrol / 2.0L TDI diesel): petrol_turbo or diesel by variant
• Mercedes C-Class / E-Class (C180/C200/E200 turbo petrol; C220D/E220D diesel): petrol_turbo or diesel by badge
• Isuzu D-Max / MU-X (3.0L 4JJ1 diesel): diesel
• Boda Boda / Motorcycle (100–200cc single cylinder): petrol_standard

Fuel types:
• regular_petrol = Regular Unleaded Petrol (RON 87–91)
• super_petrol = Super / Premium Petrol (RON 95–98)
• diesel = Automotive Diesel
• kerosene = Kerosene / Paraffin (lamp oil)

COMPATIBILITY RULES:
1. diesel + diesel → compatible ✓
2. diesel + regular_petrol → INCOMPATIBLE (diesel injectors need diesel lubrication; petrol destroys them, no compression ignition)
3. diesel + super_petrol → INCOMPATIBLE (same as above)
4. diesel + kerosene → INCOMPATIBLE (clogs modern injection systems)
5. petrol_standard + regular_petrol → compatible ✓
6. petrol_standard + super_petrol → compatible ✓ (always safe, often better)
7. petrol_standard + diesel → INCOMPATIBLE (petrol engine lacks compression to ignite diesel; engine misfires and stalls)
8. petrol_standard + kerosene → INCOMPATIBLE (damages spark plugs, catalytic converter, O2 sensor)
9. petrol_turbo + super_petrol → compatible ✓ (correct choice — turbo needs high-octane to prevent knock)
10. petrol_turbo + regular_petrol → CAUTION (regular's lower octane risks knock/detonation under boost; okay in an emergency but premium strongly recommended)
11. petrol_turbo + diesel → INCOMPATIBLE
12. petrol_turbo + kerosene → INCOMPATIBLE

Uganda pump price estimates (2025, per litre):
• regular_petrol: UGX 4,800 – 5,400
• super_petrol: UGX 5,200 – 5,900
• diesel: UGX 4,500 – 5,100
• kerosene: UGX 3,200 – 3,900

Respond ONLY with valid JSON — no markdown, no extra text:
{{
  "compatible": <true if fully compatible; false if incompatible OR caution>,
  "caution": <true ONLY for petrol_turbo + regular_petrol; false otherwise>,
  "engine_type": "<petrol_standard|petrol_turbo|diesel|hybrid>",
  "analysis": "<2–3 plain-English sentences: what engine this car has and how the chosen fuel matches it>",
  "price_estimates": {{
    "regular_petrol": "UGX 4,800 – 5,400 per litre",
    "super_petrol": "UGX 5,200 – 5,900 per litre",
    "diesel": "UGX 4,500 – 5,100 per litre",
    "kerosene": "UGX 3,200 – 3,900 per litre"
  }},
  "warning": <null if compatible; plain-English string describing the specific damage risk if caution or incompatible>,
  "recommendation": "<One specific actionable sentence telling the driver exactly what to do>"
}}"""


# ── Guided diagnosis (step-by-step Q&A) ───────────────────────────────────────

_GUIDED_SYSTEM_PROMPT = """You are MOTOFIX AI, a thorough but friendly vehicle fault triage assistant for a roadside assistance app in Uganda. The driver does NOT know what is wrong with their vehicle. Your job is to ask SHORT, simple questions ONE AT A TIME to build a clear picture of the problem, then give a confident diagnosis.

You will be given the questions already asked and the driver's answers. Decide what to do next and respond ONLY with valid JSON (no markdown, no extra text).

TO ASK THE NEXT QUESTION:
{
  "done": false,
  "question": "<one short, plain-English question someone with NO car knowledge can answer>",
  "options": ["<short answer>", "<short answer>", "<short answer>"]
}

TO GIVE THE FINAL DIAGNOSIS:
{
  "done": true,
  "diagnosis": {
    "fault_category": "<engine_failure|tyre_puncture|battery_dead|overheating|brake_failure|electrical_fault|fuel_issue|transmission_fault|suspension_damage|accident_damage|accident_with_casualties|other>",
    "fault_description": "<2-3 plain-English sentences describing the likely problem and why>",
    "provider_type": "<mechanic|towing_provider|spare_parts_dealer|ambulance>",
    "severity": "<low|medium|high|critical>",
    "confidence": <number between 0.0 and 1.0>,
    "recommended_actions": ["<simple step the driver can take now>", "<another step>", "<another step>"]
  }
}

HOW MANY QUESTIONS:
- Ask at most 1–2 short questions when the safe route is ambiguous.
- Ask first whether the vehicle can move safely; for serious smoke, brake failure, or accident damage, recommend a tow rather than prolonging triage.
- Diagnose immediately when a classic first-aid fault is clear or there is an emergency.

WHAT TO COVER (work through these progressively, one question each):
1. The main symptom (what they notice).
2. When it started and whether it was sudden or gradual.
3. When it happens (while driving, idling, starting, braking, cold/hot, going uphill, etc.).
4. The senses: any unusual sounds, smells, smoke/steam, warning lights, or vibration.
5. Whether the vehicle can still move / be driven safely.
6. Any fluid leaks under the vehicle and their colour, if relevant.
7. The kind of vehicle (boda-boda, saloon car, matatu, lorry) if not already clear.
8. Anything recent (refuelled, repair, hit a bump, drove through water) that might be related.

HOW TO QUESTION WELL:
- READ the driver's previous answers carefully and BUILD on them. If they describe something specific in their own words, ask a follow-up that digs into that detail rather than ignoring it.
- Questions MUST be answerable by someone with zero car knowledge. Use everyday words, never jargon.
- Provide 3 to 5 SHORT options (1-5 words each). The app ALSO lets the driver type their own answer in their own words, so do NOT add an "Other" or "Not sure" option.
- NEVER repeat a question or ask something the driver already answered.
- Move from broad to specific as you learn more.

SAFETY:
- If any answer mentions injured people, blood, someone unconscious, or a medical emergency → immediately return done=true with fault_category "accident_with_casualties", provider_type "ambulance", severity "critical".
- If the vehicle clearly cannot be driven safely (won't move, serious smoke, brake failure, accident) → provider_type "towing_provider".
- A tyre puncture, dead battery/jump-start, or minor safe roadside fault → provider_type "mechanic".
- State clearly whether the next step is "Roadside assist" or "Tow / recovery to a garage"; never promise a full roadside repair.

CONTEXT: Most vehicles in Uganda are boda-bodas (motorcycles), saloon cars, matatus (minibuses), or lorries. Currency is UGX."""


async def guided_diagnose(answers: list, client: AsyncGroq) -> dict:
    """Step-by-step triage: returns the next question, or a final diagnosis."""
    if answers:
        qa_text = "\n".join(f"Q: {a['question']}\nA: {a['answer']}" for a in answers)
    else:
        qa_text = "(no questions asked yet — ask your first, broad question)"

    response = await client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": _GUIDED_SYSTEM_PROMPT},
            {"role": "user", "content": (
                f"Questions asked and answers so far:\n{qa_text}\n\n"
                f"Number of questions already asked: {len(answers)}.\n"
                f"Respond with the next question, or the final diagnosis if you have enough information."
            )},
        ],
        temperature=0.2,
        max_tokens=800,
        response_format={"type": "json_object"},
    )
    result = json.loads(response.choices[0].message.content)
    if result.get("done") and isinstance(result.get("diagnosis"), dict):
        result["diagnosis"] = apply_truthful_routing(result["diagnosis"])
    return result


_PARTS_PRICE_PROMPT = """You are MOTOBOT, MOTOFIX's friendly spare-parts pricing assistant for Uganda.
Given a list of vehicle spare parts a driver wants to buy, return realistic CURRENT
Ugandan market price ranges in UGX for each item — BOTH a brand-NEW range and a
good-USED (second-hand) range.

Respond ONLY with valid JSON (no extra text) in this exact shape:
{
  "items": [
    { "name": "<tidy part name>", "new_min": <int>, "new_max": <int>, "used_min": <int>, "used_max": <int>, "note": "<short tip, max 8 words>" }
  ]
}

Rules:
  - Whole UGX numbers only, no commas or currency symbols.
  - One entry per requested item, keeping the driver's order.
  - If a part is essentially never sold second-hand (spark plugs, engine oil, brake pads,
    air/oil filters, wiper blades, inner tubes, fan belts), set used_min and used_max to 0.
  - Be realistic for Uganda 2025. Reference (UGX) as new / used:
    tyre new 180000-450000 / used 80000-250000;
    car battery new 250000-450000 / used 120000-260000;
    alternator new 200000-600000 / used 90000-300000;
    starter motor new 180000-500000 / used 80000-260000;
    side mirror new 60000-180000 / used 25000-90000;
    headlight unit new 120000-400000 / used 50000-180000;
    radiator new 150000-450000 / used 70000-220000;
    fuel pump new 120000-380000 / used 60000-180000;
    shock absorber new 90000-260000 / used 40000-120000;
    brake pads (new only) 80000-200000; spark plug each 8000-25000;
    engine oil 4L 60000-140000; air filter 25000-70000; inner tube 15000-35000.
  - For vague/unknown items, give a sensible broad new range, used only if applicable, and a helpful note.
  - These are rough public estimates, not binding quotes."""


async def price_spare_parts(items: list[str], groq_client: AsyncGroq) -> dict:
    """MOTOBOT: return UGX price ranges for a list of spare parts the driver wants."""
    item_lines = "\n".join(f"- {i}" for i in items if i and i.strip())
    resp = await groq_client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": _PARTS_PRICE_PROMPT},
            {"role": "user", "content": f"The driver wants to buy:\n{item_lines}\n\nReturn the JSON now."},
        ],
        temperature=0.2,
        max_tokens=900,
        response_format={"type": "json_object"},
    )
    data = json.loads(resp.choices[0].message.content)
    # Normalise/guard the shape
    out = []
    for it in (data.get("items") or []):
        try:
            nmin, nmax = int(it.get("new_min") or 0), int(it.get("new_max") or 0)
            umin, umax = int(it.get("used_min") or 0), int(it.get("used_max") or 0)
            # backward-compat overall range (min/max across whichever exist)
            lows = [v for v in (nmin, umin) if v > 0]
            highs = [v for v in (nmax, umax) if v > 0]
            out.append({
                "name": str(it.get("name") or "").strip() or "Spare part",
                "new_min": nmin, "new_max": nmax,
                "used_min": umin, "used_max": umax,
                "price_min": min(lows) if lows else 0,
                "price_max": max(highs) if highs else 0,
                "note": (str(it.get("note")).strip() if it.get("note") else None),
            })
        except (ValueError, TypeError):
            continue
    return {"items": out, "currency": "UGX"}


# ─── Rotating, AI-written home-screen headlines ────────────────────────────────
_GREETING_FALLBACK = {
    ("mechanic", "latenight"):    ["Beat the competition tonight,", "Night shifts pay the most,", "Stranded drivers need you now,", "Catch a late-night hustle,"],
    ("mechanic", "earlymorning"): ["Pick up an early request,", "Rise and claim those jobs,", "Early birds earn the most,", "Beat the morning rush,"],
    ("mechanic", "morning"):      ["Morning jobs are rolling in,", "Make the most of your morning,", "Catch the day's best jobs,", "Cars need fixing this morning,"],
    ("mechanic", "afternoon"):    ["Afternoon hustle mode on,", "Midday jobs are waiting,", "Keep the grind going,", "Peak hours are starting,"],
    ("mechanic", "evening"):      ["Evening rush is starting,", "Best hours to be online,", "Catch the evening wave,", "Breakdowns don't stop at night,"],
    ("driver", "latenight"):      ["Car trouble this late?", "Stuck after dark?", "Help is one tap away,", "Stranded tonight?"],
    ("driver", "earlymorning"):   ["Rough start this morning?", "Car won't cooperate?", "Trouble before work?", "Need a quick fix?"],
    ("driver", "morning"):        ["Having a rough morning?", "Car giving you trouble?", "Stuck on the road?", "Need a hand this morning?"],
    ("driver", "afternoon"):      ["Having a rough afternoon?", "Car acting up?", "Stranded somewhere?", "Need help right now?"],
    ("driver", "evening"):        ["Having a rough evening?", "Car trouble tonight?", "Stuck after dark?", "Help is one tap away,"],
}

def fallback_greetings(role: str, period: str) -> list[str]:
    return (
        _GREETING_FALLBACK.get((role, period))
        or _GREETING_FALLBACK.get((role, "evening"))
        or ["Welcome back,"]
    )

async def generate_greetings(role: str, period: str, groq_client: AsyncGroq) -> list[str]:
    """A batch of short, varied home-screen headlines for the role + time of day.
    The frontend caches the batch and rotates through it; this is called per login."""
    if role == "mechanic":
        audience = "a roadside mechanic / tow provider on a Ugandan roadside-assistance app called MOTOFIX"
        brief = (
            "Motivate them to stay online and grab breakdown jobs — hustle and earning energy. "
            "Each line must read naturally with the person's FIRST NAME appended right after, so "
            "end every line with a comma (e.g. 'Evening rush is starting,')."
        )
    else:
        audience = "a driver on a Ugandan roadside-assistance app called MOTOFIX who might have car trouble"
        brief = (
            "Warm and reassuring, often a short question, reminding them help is one tap away. "
            "Standalone short lines or questions (e.g. 'Having a rough evening?')."
        )
    prompt = (
        f"Write 12 fresh, varied home-screen greeting headlines for {audience}. Time of day: {period}. "
        f"{brief} Each at most 6 words. No emojis, no numbering, no surrounding quotes. "
        'Return JSON exactly as: {"messages": ["...", "..."]}'
    )
    resp = await groq_client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": prompt}],
        temperature=1.0,
        max_tokens=400,
        response_format={"type": "json_object"},
    )
    data = json.loads(resp.choices[0].message.content)
    msgs = [str(s).strip() for s in (data.get("messages") or []) if str(s).strip()]
    msgs = [m for m in msgs if len(m) <= 48][:12]
    return msgs or fallback_greetings(role, period)


# ─── Job-completion estimate — tickable fixes + AI cost/transport breakdown ─────
def fallback_service_estimate(issue: str, distance_km: float) -> dict:
    d = max(0.5, min(20.0, distance_km if distance_km and distance_km > 0 else 3.0))
    t_min, t_max = int(2000 + d * 800), int(3000 + d * 1500)
    return {
        "fix_options": ["Diagnosed the fault", "Carried out the repair", "Replaced the worn part", "Tested the vehicle", "Cleaned up and finished"],
        "transport": {"min": t_min, "max": t_max},
        "labour":    {"min": 10000, "max": 30000},
        "parts":     {"min": 0, "max": 50000},
        "total":     {"min": t_min + 10000, "max": t_max + 80000},
        "source": "fallback",
    }

def _rng(o, dmin: int, dmax: int) -> dict:
    try:
        mn = int(o.get("min") if o.get("min") is not None else dmin)
        mx = int(o.get("max") if o.get("max") is not None else dmax)
        mn = max(0, mn)
        return {"min": mn, "max": max(mn, mx)}
    except (ValueError, TypeError, AttributeError):
        return {"min": dmin, "max": dmax}

async def service_estimate(issue: str, description: str, distance_km: float, groq_client: AsyncGroq) -> dict:
    """For a finished job: a tickable list of likely fixes + an AI cost breakdown
    (boda transport for the distance travelled + labour + parts) for Kampala, Uganda."""
    dist = distance_km if distance_km and distance_km > 0 else 3.0
    prompt = (
        f"A mechanic on MOTOFIX (roadside assistance in Kampala, Uganda) just finished a job and "
        f"needs to bill the driver. Fault: '{issue or 'vehicle fault'}'. "
        f"Driver's description: '{description or 'n/a'}'. "
        f"The mechanic travelled about {dist:.1f} km by boda boda to reach the driver. "
        "Return realistic 2026 Ugandan-Shilling figures as JSON:\n"
        '{"fix_options": ["up to 7 short specific things a mechanic commonly does to fix THIS fault, each <=5 words"], '
        '"transport": {"min": <ugx>, "max": <ugx>}, "labour": {"min": <ugx>, "max": <ugx>}, '
        '"parts": {"min": <ugx>, "max": <ugx>}, "total": {"min": <ugx>, "max": <ugx>}}\n'
        "transport = a fair boda fare for that distance. parts = 0..max if no new parts needed. "
        "total = transport+labour+parts. Return ONLY the JSON."
    )
    resp = await groq_client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.4,
        max_tokens=600,
        response_format={"type": "json_object"},
    )
    data = json.loads(resp.choices[0].message.content)
    fb = fallback_service_estimate(issue, dist)
    fixes = [str(s).strip() for s in (data.get("fix_options") or []) if str(s).strip()][:7] or fb["fix_options"]
    transport = _rng(data.get("transport") or {}, fb["transport"]["min"], fb["transport"]["max"])
    labour    = _rng(data.get("labour") or {}, fb["labour"]["min"], fb["labour"]["max"])
    parts     = _rng(data.get("parts") or {}, fb["parts"]["min"], fb["parts"]["max"])
    total     = _rng(data.get("total") or {}, transport["min"] + labour["min"] + parts["min"], transport["max"] + labour["max"] + parts["max"])
    return {"fix_options": fixes, "transport": transport, "labour": labour, "parts": parts, "total": total, "source": "ai"}


async def fuel_advisor(car_model: str, fuel_type: str, groq_client: AsyncGroq) -> dict:
    """AI fuel-engine compatibility analysis for Uganda drivers."""
    prompt = _FUEL_ADVISOR_PROMPT.format(car_model=car_model, fuel_type=fuel_type)
    resp = await groq_client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.1,
        max_tokens=900,
    )
    raw = resp.choices[0].message.content.strip()
    # Strip markdown code fences if the model wrapped the response
    if "```" in raw:
        for part in raw.split("```"):
            part = part.strip().lstrip("json").strip()
            if part.startswith("{"):
                raw = part
                break
    return json.loads(raw)


_CHATBOT_SYSTEM_PROMPT = """You are MOTOBOT, MOTOFIX's own AI assistant embedded in the MOTOFIX roadside assistance platform in Uganda. When asked who you are, say you are MOTOBOT.

━━ SCOPE — STRICT ━━
You may ONLY discuss topics that fall within the MOTOFIX platform context:

1. VEHICLE FAULTS & MECHANICAL ISSUES
   - Engine, battery, tyres/punctures, brakes, fuel, overheating, electrical faults,
     transmission, suspension, accident damage, fluid leaks, exhaust, cooling system,
     boda-boda (motorcycle) faults, matatu/minibus faults, lorry/truck breakdowns.

2. ROADSIDE ASSISTANCE & EMERGENCY HELP
   - Requesting a mechanic, towing provider, or spare parts dealer via MOTOFIX.
   - On-road medical emergencies and ambulance dispatch through MOTOFIX.
   - Safety advice while waiting for help (e.g. hazard lights, safe distance from traffic).
    - Be clear: roadside assist is first aid and triage; if the fault is complex or unsafe to repair on the road, recommend tow/recovery to a garage or safer place.
    - Never promise that a mechanic will fully repair every problem at the driver's location.

3. INSURANCE — MOTOFIX COVERAGE & CLAIMS
   - How MOTOFIX insurance coverage works for registered drivers.
   - What incidents are covered (breakdown, accident, medical, theft-related).
   - How to start or track a claim through the MOTOFIX platform.
   - Documents required for a claim submission.

4. MOTOFIX PLATFORM QUESTIONS
   - How to request a service, service types available, service areas in Uganda,
     pricing / payment via Mobile Money, how to track a mechanic, profile & account questions.

━━ OUT-OF-SCOPE — REDIRECT ━━
If the driver asks about ANYTHING outside the topics above, respond with:
"I'm specialised in vehicle faults and roadside assistance for MOTOFIX. I can't help with that,
but I'm here the moment you have a vehicle issue or need to know about MOTOFIX services."
Do NOT attempt to answer out-of-scope questions even partially.

━━ CONVERSATION GUIDELINES ━━
- Keep responses short (2-3 sentences max) — the driver may be stressed or have low connectivity.
- Ask one focused question at a time.
- Open with brief empathy before asking questions.
- After 3-4 exchanges you should have enough info. Do not keep asking once you have it.
- Common vehicle types in Uganda: boda-boda (motorcycle), saloon car, matatu (minibus), lorry/truck.
- Currency: Ugandan Shillings (UGX). Payment is via MTN MoMo or Airtel Money.

When you have gathered enough information to dispatch the right help, end your response with exactly:
DIAGNOSIS_READY: true

Otherwise end with:
DIAGNOSIS_READY: false"""

# MOTOBOT speaking to a PROFESSIONAL MECHANIC (a verified MOTOFIX provider), not a stranded
# driver — so it gives detailed, technical, step-by-step repair guidance instead of short triage.
_MECHANIC_SYSTEM_PROMPT = """You are MOTOBOT, MOTOFIX's AI assistant — here you are helping a PROFESSIONAL MECHANIC (a verified MOTOFIX service provider), NOT a stranded driver. When asked who you are, say you are MOTOBOT.

━━ WHO YOU'RE TALKING TO ━━
A working mechanic in Uganda who wants practical help diagnosing and FIXING vehicle faults. Assume solid hands-on knowledge — don't over-explain the basics, but be precise and technical.

━━ SCOPE — STRICT (vehicles only) ━━
Only discuss vehicle faults, diagnosis, repair procedures, parts, tools and servicing for cars, boda-bodas (motorcycles), matatus (minibuses) and lorries/trucks. If asked anything off-topic, reply exactly: "I'm MOTOBOT — I stick to vehicle diagnosis and repairs. Ask me about any fault you're working on." Do not answer off-topic questions even partially.

━━ HOW TO ANSWER ━━
- Give DETAILED, step-by-step diagnostic and repair guidance. NUMBER the steps.
- Lead with the most likely cause, then how to CONFIRM it — the exact tests, measurements and expected readings (e.g. healthy battery 12.6V, alternator output 13.8–14.7V, brake pad minimum 3mm).
- Name the specific parts and tools needed, with rough UGX price ranges where useful.
- ALWAYS flag safety risks (e.g. never open a hot radiator cap; support the vehicle on axle stands, never just a jack).
- Ugandan context: common vehicles, local parts availability, currency in UGX.
- Use short paragraphs with numbered/bulleted lists. You may be longer than a driver chat, but stay practical — no filler.
- Use **bold** for key terms, readings and part names.

Always end your response with exactly:
DIAGNOSIS_READY: false"""

MODEL        = "llama-3.3-70b-versatile"
VISION_MODEL = "llama-3.2-90b-vision-preview"

_IMAGE_PROMPT = """STEP 1 — RELEVANCE CHECK (do this first):
Is this image of a vehicle or a vehicle part (car, motorcycle, boda-boda, matatu, bus, truck,
tyre, wheel, engine, dashboard, bumper, etc.)?

If NO — the image does not show any vehicle or vehicle part — respond with exactly:
NON_VEHICLE_IMAGE

If YES — proceed to Step 2.

STEP 2 — DESCRIBE WHAT YOU PHYSICALLY SEE. Be literal and precise.
DO NOT diagnose or infer — only describe visible facts.

VEHICLE PARTS VISIBLE:
  Which part of the vehicle is shown — front, rear, side, interior, engine bay, wheel/tyre, underbody, etc.

CONDITION OF EACH PART:
  For each part, describe its exact condition:
  - Intact and normal, or damaged?
  - If damaged: dented, crumpled, cracked, broken, missing, bent, scraped, burned?
  - If a tyre: round and fully inflated, or visibly squashed/flat/deflated? Any object embedded?
  - If engine area: smoke, steam, dripping liquid, or broken components visible?

PEOPLE:
  Anyone visible? Do they appear injured, unconscious, or distressed?

GROUND:
  Any liquid pooling beneath the vehicle?

RULES:
  - Do NOT say "flat tyre" unless the tyre is visibly squashed or clearly deflated.
  - If a part looks completely normal, say so — do not invent damage.
  - If image is too dark or unclear, say so."""

# ── Text diagnosis ────────────────────────────────────────────────────────────

async def diagnose_text(description: str, client: AsyncGroq | None = None) -> DiagnosisResult:
    # `client` is legacy (Groq, kept for existing call sites) — diagnosis runs on Claude.
    if not _anthropic:
        return _diagnosis_fallback()
    try:
        resp = await _anthropic.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=700,
            system=_DIAGNOSIS_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": f"Vehicle fault report: {description}"}],
        )
        data = json.loads(_extract_json(_claude_text(resp)))
        return DiagnosisResult(**apply_truthful_routing(data))
    except Exception as exc:
        logger.error("Claude text diagnosis failed: %s", exc)
        return _diagnosis_fallback()


# ── Image diagnosis (Claude vision — single multimodal call) ──────────────────

_VALID_IMAGE_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}


async def diagnose_image(image_bytes: bytes, content_type: str, client: AsyncGroq | None = None, issue: str | None = None) -> DiagnosisResult:
    # `client` is legacy (Groq) — image diagnosis runs on Claude (one multimodal call).
    if not _anthropic:
        return _diagnosis_fallback(image=True)

    media_type = content_type if content_type in _VALID_IMAGE_TYPES else "image/jpeg"
    b64 = base64.b64encode(image_bytes).decode("utf-8")
    issue_txt = (issue or "").strip() or "the reported problem"

    relevance = (
        "\n\nYou are inspecting a PHOTO the driver uploaded for this reported issue: "
        f"\"{issue_txt}\". Judge the photo BEFORE diagnosing, and ALSO return two extra JSON fields — "
        "\"image_relevant\" (boolean) and \"image_feedback\" (string):\n"
        "- If the photo does NOT show a vehicle or a vehicle part (e.g. a tree, building, person, food, "
        "or any random object), set image_relevant=false and write image_feedback naming what the photo "
        f"ACTUALLY shows, e.g. \"That looks like a tree, not your vehicle — please upload a clear photo of {issue_txt}.\"\n"
        "- If it shows a vehicle/part but is clearly UNRELATED to the reported issue (e.g. the issue is a "
        "flat tyre but the photo shows an engine bay, dashboard or mirror — not a tyre/wheel), set "
        "image_relevant=false and write image_feedback naming what you see, e.g. \"This looks like a car "
        f"dashboard, not the reported {issue_txt} — please upload a photo of that.\"\n"
        "- Otherwise set image_relevant=true and fill the full diagnosis from what you actually SEE in the "
        "photo. Do not invent damage that isn't visible.\n"
        "\nPHOTO CLARITY: if the photo IS the right subject (image_relevant=true) but you genuinely CANNOT assess "
        "the damage well — it's blurry, too dark, too far away, badly angled, glare-washed, or the damaged area is "
        "obstructed — set \"needs_better_photo\"=true and write image_feedback asking the driver to take ANOTHER "
        "shot from a DIFFERENT ANGLE, closer and in good light (e.g. \"I can see it's your front bumper but the "
        "photo is blurry — please take another, closer shot from a different angle so I can assess it properly.\"). "
        "In that case set repair_or_replace=\"inspect\". If the photo is clear enough to judge, set needs_better_photo=false.\n"
        "  IMPORTANT: a merely imperfect angle or distance is NOT a reason to ask for another photo or to pick "
        "\"inspect\" if the damage you CAN see is already obviously severe. If the part is plainly destroyed — a "
        "shredded/burst/flat-and-gashed tyre, a split sidewall, shattered glass, a bent/cracked rim, a deeply "
        "crumpled panel — you have MORE than enough to make the call: set needs_better_photo=false and give a "
        "decisive verdict. Only ask for a better photo when you cannot tell how SEVERE the damage is.\n"
        "\nREPAIR-VS-REPLACE VERDICT (when image_relevant=true): look hard at how BAD the visible damage is "
        "and make a decisive call. Return two more fields, \"repair_or_replace\" and \"repair_or_replace_reason\":\n"
        "  • \"repair\"  — the damage looks superficial/minor and an on-site fix will genuinely HOLD (e.g. a small "
        "tread-area puncture, a loose or corroded battery terminal, a minor surface dent, a leak from a loose clamp). "
        "Put the realistic fix cost in repair_fee_min/repair_fee_max.\n"
        "  • \"replace\" — the damage is deep, structural, torn, cracked, shattered, bent, or worn BEYOND a safe "
        "repair, so a patch-up would NOT hold and a NEW part is genuinely required (e.g. a gashed or split tyre "
        "sidewall, a shredded tyre, a shattered or cracked headlamp/lens, a cracked or buckled alloy rim, a holed "
        "radiator, a snapped suspension arm, a deeply crumpled panel). When you choose replace you MUST set "
        "repair_fee_min AND repair_fee_max to 0, and required_parts MUST list the part(s) needed — never dangle a "
        "cheap fix that will fail.\n"
        "  • \"inspect\" — LAST RESORT ONLY: use this just when the photo genuinely cannot reveal the SEVERITY "
        "(the damaged area is hidden/obstructed, or it is too blurry/dark to see the damage at all). Do NOT pick "
        "inspect merely because the angle or distance isn't perfect — if the damage is clearly visible, commit to "
        "repair or replace.\n"
        "  STRONGLY PREFER A DECISIVE repair/replace verdict — drivers act on it. Obvious, clearly-visible severe "
        "damage is \"replace\"; an obvious minor issue is \"repair\". Only fall back to \"inspect\" when you truly "
        "cannot read the severity from the photo.\n"
        "  Set repair_or_replace_reason to ONE short, specific sentence grounded in what is actually visible "
        "(e.g. \"The sidewall is split — a plug won't hold, so the tyre needs replacing.\"). Be honest: if a repair "
        "truly won't last, say replace even though it costs more — a fix that fails on the road is worse.\n"
        "Respond with the same JSON object defined above, now also including image_relevant, image_feedback (when "
        "false OR when needs_better_photo is true), needs_better_photo, and (when relevant) repair_or_replace + "
        "repair_or_replace_reason."
    )

    try:
        resp = await _anthropic.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=900,
            system=_DIAGNOSIS_SYSTEM_PROMPT + relevance,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64}},
                    {"type": "text", "text": f"Reported issue: \"{issue_txt}\". Assess this photo and respond with the JSON."},
                ],
            }],
        )
        data = json.loads(_extract_json(_claude_text(resp)))
        result = DiagnosisResult(**apply_truthful_routing(data))
        if result.image_relevant is None:
            result.image_relevant = True
        return result
    except Exception as exc:
        logger.error("Claude image diagnosis failed: %s", exc)
        return _diagnosis_fallback(image=True)


# ── Image-triggered chat (vision → conversational follow-up) ─────────────────

_CHAT_IMAGE_RULES = """

━━ THE DRIVER JUST UPLOADED A PHOTO — LOOK AT IT ━━
1. If it is NOT a vehicle or a vehicle part (a tree, building, person, food, random object),
   say so warmly and ask them to upload a clear photo of their vehicle or the faulty part.
   Do NOT diagnose.
2. Otherwise tell the driver what you can ACTUALLY SEE in plain language — the vehicle type and
   any visible damage/problem (e.g. "I can see a flat, deflated tyre", "I can see a dented front bumper").
   Do NOT invent damage that isn't visible; if a part looks normal, say so and ask what they're experiencing.
3. Ask ONE short, relevant follow-up question (after body damage: "Are you or anyone else injured?";
   after a flat tyre: "Can you still move the vehicle, or is it completely stuck?").
4. Do NOT declare DIAGNOSIS_READY yet — wait for the driver's reply. Maximum 2–3 sentences."""


async def chat_with_image(
    image_bytes: bytes,
    content_type: str,
    prior_messages: List[ChatMessage],
    user_text: str,
    client: AsyncGroq | None = None,
    persona: str = "driver",
) -> ChatResponse:
    # `client` is legacy (Groq) — image chat now runs on Claude (one multimodal call).
    if not _anthropic:
        return _chat_fallback("I can see you've sent a photo. Could you tell me a bit more about what's happening with your vehicle?")

    media_type = content_type if content_type in _VALID_IMAGE_TYPES else "image/jpeg"
    b64 = base64.b64encode(image_bytes).decode("utf-8")

    convo = _as_claude_msgs(prior_messages)
    user_content = [
        {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64}},
        {"type": "text", "text": user_text if user_text else "[I've uploaded a photo of my vehicle — what can you see?]"},
    ]
    convo.append({"role": "user", "content": user_content})

    try:
        is_mechanic = persona == "mechanic"
        resp = await _anthropic.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=700 if is_mechanic else 400,
            system=(_MECHANIC_SYSTEM_PROMPT if is_mechanic else _CHATBOT_SYSTEM_PROMPT) + _CHAT_IMAGE_RULES,
            messages=convo,
        )
        raw_reply = _claude_text(resp)
        diagnosis_ready = "DIAGNOSIS_READY: true" in raw_reply
        clean_reply = (
            raw_reply.replace("DIAGNOSIS_READY: true", "").replace("DIAGNOSIS_READY: false", "").strip()
        )

        diagnosis = None
        if diagnosis_ready:
            driver_msgs = " ".join(m.content for m in prior_messages if m.role == "user")
            context = f"{driver_msgs}. From the uploaded photo: {clean_reply}."
            if user_text:
                context += f" Driver also said: {user_text}"
            diagnosis = await diagnose_text(context)

        return ChatResponse(reply=clean_reply, diagnosis_ready=diagnosis_ready, diagnosis=diagnosis)

    except Exception as exc:
        logger.error("Claude image chat failed: %s", exc)
        return _chat_fallback("I can see you've sent a photo. Could you tell me a bit more about what's happening with your vehicle?")


# ── Chatbot ───────────────────────────────────────────────────────────────────

async def transcribe_audio(audio_bytes: bytes, filename: str, client: AsyncGroq) -> str:
    """Voice note → text (any language → English) via Groq Whisper translations."""
    try:
        resp = await client.audio.translations.create(
            file=(filename or "voice.webm", audio_bytes),
            model="whisper-large-v3",
        )
        return (getattr(resp, "text", "") or "").strip()
    except Exception as exc:
        logger.error("Groq transcription failed: %s", exc)
        return ""


async def chat_diagnose(messages: List[ChatMessage], client: AsyncGroq | None = None, persona: str = "driver") -> ChatResponse:
    # `client` is legacy (Groq) — the chatbot now runs on Claude.
    if not _anthropic:
        return _chat_fallback()

    convo = _as_claude_msgs(messages)
    if not convo:
        convo = [{"role": "user", "content": "Hello"}]

    is_mechanic = persona == "mechanic"
    try:
        resp = await _anthropic.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=700 if is_mechanic else 400,
            system=_MECHANIC_SYSTEM_PROMPT if is_mechanic else _CHATBOT_SYSTEM_PROMPT,
            messages=convo,
        )
        raw_reply = _claude_text(resp)
        # The system prompt tells MOTOBOT to end every reply with "DIAGNOSIS_READY: true"
        # once it has enough info to dispatch help (or "...: false" if it needs to keep asking).
        # We check for that marker, then strip it out so the driver never sees it.
        diagnosis_ready = "DIAGNOSIS_READY: true" in raw_reply
        clean_reply = (
            raw_reply.replace("DIAGNOSIS_READY: true", "").replace("DIAGNOSIS_READY: false", "").strip()
        )

        # Once ready, feed everything the driver said into the proper diagnosis engine
        # to get the structured result (fault category, severity, who to send, etc.).
        diagnosis = None
        if diagnosis_ready:
            user_context = " ".join(m.content for m in messages if m.role == "user")
            diagnosis = await diagnose_text(user_context)

        return ChatResponse(reply=clean_reply, diagnosis_ready=diagnosis_ready, diagnosis=diagnosis)
    except Exception as exc:
        logger.error("Claude chatbot turn failed: %s", exc)
        return _chat_fallback()
