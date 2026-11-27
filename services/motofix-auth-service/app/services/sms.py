# app/services/sms.py
# Sends text messages (SMS) to phones — mainly the one-time codes for login/sign-up.
# We use "Africa's Talking", an SMS provider that works well across Ugandan networks.
#
# If no API key is set, SMS delivery is skipped.

import os
import logging
import httpx

logger = logging.getLogger(__name__)

_AT_USERNAME = os.getenv("AT_USERNAME", "sandbox")
_AT_API_KEY  = os.getenv("AT_API_KEY", "")
_AT_SMS_URL  = "https://api.africastalking.com/version1/messaging"
# Optional registered sender ID (alphanumeric or shortcode). Only sent when set.
_AT_SENDER_ID = os.getenv("AT_SENDER_ID", "").strip()

# Africa's Talking per-recipient status codes that mean the message was accepted for
# delivery: 100 Processed, 101 Sent, 102 Queued. Anything else (e.g. 402 InvalidSenderId,
# 405 InsufficientBalance, 406 UserInBlacklist, 407 CouldNotRoute) is a failure.
_AT_OK_CODES = {100, 101, 102}


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
    """Send SMS via Africa's Talking REST API when provider credentials are configured."""
    formatted = format_phone(phone)

    if not _AT_API_KEY:
        logger.warning("SMS provider skipped: AT_API_KEY is not configured")
        return True

    try:
        logger.info("Calling Africa's Talking SMS provider")
        payload = {
            "username": _AT_USERNAME,
            "to": formatted,
            "message": message,
        }
        if _AT_SENDER_ID:
            payload["from"] = _AT_SENDER_ID

        with httpx.Client(timeout=10) as client:
            resp = client.post(
                _AT_SMS_URL,
                headers={
                    "apiKey": _AT_API_KEY,
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Accept": "application/json",
                },
                data=payload,
            )
        resp.raise_for_status()

        # HTTP 201 only means Africa's Talking received the request. The real outcome for
        # the number is inside the body, so read it and log it (never the message text).
        try:
            response_data = resp.json()
        except ValueError:
            response_data = {}
        message_data = response_data.get("SMSMessageData", {}) if isinstance(response_data, dict) else {}
        recipients = message_data.get("Recipients", []) if isinstance(message_data, dict) else []

        if not recipients:
            logger.error("SMS provider returned no recipient status")
            return False

        delivered = True
        for recipient in recipients:
            status_text = str(recipient.get("status", "unknown"))
            status_code = recipient.get("statusCode")
            cost = recipient.get("cost")
            if status_text == "Success":
                logger.info(
                    "SMS recipient result: status=%s statusCode=%s cost=%s",
                    status_text, status_code, cost,
                )
            else:
                logger.warning(
                    "SMS recipient result: status=%s statusCode=%s cost=%s",
                    status_text, status_code, cost,
                )
            if status_code not in _AT_OK_CODES and status_text.lower() != "success":
                delivered = False
        return delivered
    except Exception as exc:
        logger.error("SMS provider call failed: %s", type(exc).__name__)
        return False
