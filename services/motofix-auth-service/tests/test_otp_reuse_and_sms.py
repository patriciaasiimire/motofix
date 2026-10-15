"""
Tests for:
  * get_recent_otp()  - a retried "send code" request re-uses the still-valid code
  * store_otp()       - OTP codes are only written to the logs when DEBUG_LOG_OTP=true
  * send_sms()        - the Africa's Talking per-recipient status decides success

These modules are loaded straight from their files so the tests do not need a
database, FastAPI, or network access.
"""

import asyncio
import importlib.util
import logging
import pathlib
import sys
import types
from datetime import datetime, timedelta, timezone

APP_DIR = pathlib.Path(__file__).resolve().parents[1] / "app" / "services"


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, APP_DIR / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# httpx is a real dependency in CI; fall back to a stub only when it is missing.
if "httpx" not in sys.modules:
    try:
        import httpx  # noqa: F401
    except ImportError:
        stub = types.ModuleType("httpx")
        stub.Client = object
        sys.modules["httpx"] = stub

otp = _load("otp_under_test", "otp.py")
sms = _load("sms_under_test", "sms.py")


class FakeConn:
    def __init__(self, row=None):
        self.row = row
        self.executed = []

    async def fetchrow(self, query, *args):
        return self.row

    async def execute(self, query, *args):
        self.executed.append((query, args))


def _row(created_seconds_ago: int, expires_in_seconds: int, code: str = "123456"):
    now = datetime.now(timezone.utc)
    return {
        "otp_code": code,
        "created_at": now - timedelta(seconds=created_seconds_ago),
        "expires_at": now + timedelta(seconds=expires_in_seconds),
    }


# ── get_recent_otp ──────────────────────────────────────────────────────────

def test_recent_otp_is_reused():
    conn = FakeConn(_row(created_seconds_ago=10, expires_in_seconds=290))
    assert asyncio.run(otp.get_recent_otp(conn, "+256700000001")) == "123456"


def test_old_otp_is_not_reused():
    conn = FakeConn(_row(created_seconds_ago=120, expires_in_seconds=180))
    assert asyncio.run(otp.get_recent_otp(conn, "+256700000001")) is None


def test_expired_otp_is_not_reused():
    conn = FakeConn(_row(created_seconds_ago=10, expires_in_seconds=-1))
    assert asyncio.run(otp.get_recent_otp(conn, "+256700000001")) is None


def test_no_otp_row_returns_none():
    assert asyncio.run(otp.get_recent_otp(FakeConn(None), "+256700000001")) is None


def test_naive_timestamps_are_handled():
    now = datetime.utcnow()
    conn = FakeConn({
        "otp_code": "654321",
        "created_at": now - timedelta(seconds=5),
        "expires_at": now + timedelta(minutes=4),
    })
    assert asyncio.run(otp.get_recent_otp(conn, "+256700000001")) == "654321"


# ── OTP log gating ──────────────────────────────────────────────────────────

class _ListHandler(logging.Handler):
    def __init__(self):
        super().__init__()
        self.messages = []

    def emit(self, record):
        self.messages.append(record.getMessage())


def _store_and_collect_logs(log_otp: bool):
    handler = _ListHandler()
    otp.logger.addHandler(handler)
    previous_level = otp.logger.level
    otp.logger.setLevel(logging.DEBUG)
    previous_flag = otp._LOG_OTP
    otp._LOG_OTP = log_otp
    try:
        asyncio.run(otp.store_otp(FakeConn(), "+256700000001", "987654"))
    finally:
        otp._LOG_OTP = previous_flag
        otp.logger.setLevel(previous_level)
        otp.logger.removeHandler(handler)
    return handler.messages


def test_otp_not_logged_by_default():
    messages = _store_and_collect_logs(log_otp=False)
    assert not any("987654" in m for m in messages)


def test_otp_logged_only_when_enabled():
    messages = _store_and_collect_logs(log_otp=True)
    assert any("987654" in m for m in messages)


# ── send_sms ────────────────────────────────────────────────────────────────

class _Resp:
    def __init__(self, body):
        self._body = body

    def raise_for_status(self):
        return None

    def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


def _fake_client(body, sent):
    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def post(self, url, headers=None, data=None):
            sent.append(data)
            return _Resp(body)

    return FakeClient


def _run_send_sms(body, sender_id=""):
    sent = []
    originals = (sms._AT_API_KEY, sms._AT_SENDER_ID, getattr(sms.httpx, "Client", None))
    sms._AT_API_KEY = "test-key"
    sms._AT_SENDER_ID = sender_id
    sms.httpx.Client = _fake_client(body, sent)
    try:
        result = sms.send_sms("0700000001", "MOTOFIX: Your verification code is 111111.")
    finally:
        sms._AT_API_KEY, sms._AT_SENDER_ID, sms.httpx.Client = originals
    return result, sent


def _body(status, code):
    return {"SMSMessageData": {"Recipients": [{"number": "+256700000001", "status": status, "statusCode": code}]}}


def test_sms_success_status_returns_true():
    ok, _ = _run_send_sms(_body("Success", 101))
    assert ok is True


def test_sms_insufficient_balance_returns_false():
    ok, _ = _run_send_sms(_body("InsufficientBalance", 405))
    assert ok is False


def test_sms_invalid_sender_id_returns_false():
    ok, _ = _run_send_sms(_body("InvalidSenderId", 402))
    assert ok is False


def test_sms_without_recipients_returns_false():
    ok, _ = _run_send_sms({"SMSMessageData": {"Message": "Sent to 0/1", "Recipients": []}})
    assert ok is False


def test_sms_invalid_json_returns_false():
    ok, _ = _run_send_sms(ValueError("not json"))
    assert ok is False


def test_sender_id_is_sent_only_when_configured():
    _, sent = _run_send_sms(_body("Success", 101), sender_id="")
    assert "from" not in sent[0]
    _, sent = _run_send_sms(_body("Success", 101), sender_id="MOTOFIX")
    assert sent[0]["from"] == "MOTOFIX"


if __name__ == "__main__":
    failures = 0
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    for name, fn in tests:
        try:
            fn()
            print(f"PASS  {name}")
        except Exception as exc:  # noqa: BLE001
            failures += 1
            print(f"FAIL  {name}: {type(exc).__name__}: {exc}")
    print(f"\n{len(tests) - failures}/{len(tests)} passed")
    sys.exit(1 if failures else 0)
