# app/services/sms.py
# Sends text messages (SMS) to phones — mainly the one-time codes for login/sign-up.
# We use "Africa's Talking", an SMS provider that works well across Ugandan networks.
#
# Handy for development: if no API key is set, send_sms() doesn't actually send
# anything — it just prints the message to the server log so you can still read the
# OTP and keep testing without spending SMS credit.

import os
import logging
import httpx

logger = logging.getLogger(__name__)

_AT_USERNAME = os.getenv("AT_USERNAME", "sandbox")
_AT_API_KEY  = os.getenv("AT_API_KEY", "")
_AT_SMS_URL  = "https://api.africastalking.com/version1/messaging"


def format_phone(phone: str) -> str:
    """Normalise to international format +256XXXXXXXXX."""
    phone = phone.strip()
    if phone.startswith("+256"):
        return phone
    if phone.startswith("256"):
        return "+" + phone
    if phone.startswith("0"):
        return "+256" + phone[1:]
    return "+256" + phone


def send_sms(phone: str, message: str) -> bool:
    """Send SMS via Africa's Talking REST API; falls back to console log if not configured."""
    formatted = format_phone(phone)
    masked_phone = formatted[-4:]

    if not _AT_API_KEY:
        logger.warning(
            "SMS provider skipped for phone ending %s: AT_API_KEY is not configured",
            masked_phone,
        )
        return True

    try:
        logger.info("Calling Africa's Talking SMS provider for phone ending %s", masked_phone)
        with httpx.Client(timeout=10) as client:
            resp = client.post(
                _AT_SMS_URL,
                headers={
                    "apiKey": _AT_API_KEY,
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Accept": "application/json",
                },
                data={
                    "username": _AT_USERNAME,
                    "to": formatted,
                    "message": message,
                },
            )
        resp.raise_for_status()
        logger.info("SMS provider accepted message for phone ending %s", masked_phone)
        return True
    except Exception as exc:
        logger.error("SMS provider call failed for phone ending %s: %s", masked_phone, exc)
        return False
