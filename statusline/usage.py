"""OAuth usage API client for Claude Code statusline.

Fetches utilization percentages from the Anthropic usage API, with caching,
circuit breaker, and beta header resilience.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

USAGE_API_URL = "https://api.anthropic.com/api/oauth/usage"
BETA_HEADER = "oauth-2025-04-20"
CACHE_TTL = 300  # seconds
MAX_CONSECUTIVE_FAILURES = 3

_NONE_RESULT: dict[str, object] = {
    "five_hour_pct": None,
    "five_hour_resets_at": None,
    "seven_day_pct": None,
    "seven_day_resets_at": None,
    "seven_day_sonnet_pct": None,
    "seven_day_sonnet_resets_at": None,
    "extra_usage_enabled": None,
}

# ---------------------------------------------------------------------------
# Module-level state
# ---------------------------------------------------------------------------

_beta_disabled: bool = False

# Circuit breaker state
_consecutive_failures: int = 0
_backoff_until: float = 0.0
_backoff_delay: float = CACHE_TTL  # starts at 300s, doubles, caps at 3600s


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------


def _cache_path() -> str:
    uid = os.getuid()
    return f"/tmp/cc-statusline-usage-{uid}"


def _read_cache() -> dict | None:
    path = _cache_path()
    try:
        mtime = os.path.getmtime(path)
        if (time.time() - mtime) < CACHE_TTL:
            with open(path) as f:
                return json.load(f)
    except (OSError, json.JSONDecodeError, ValueError):
        pass
    return None


def _write_cache(data: dict) -> None:
    path = _cache_path()
    try:
        cache_dir = os.path.dirname(path)
        fd, tmp_path = tempfile.mkstemp(dir=cache_dir, prefix=".cc-statusline-usage-")
        with os.fdopen(fd, "w") as f:
            json.dump(data, f)
        os.rename(tmp_path, path)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Credential extraction
# ---------------------------------------------------------------------------


def _credentials_file_path() -> str:
    return os.path.expanduser("~/.claude/.credentials.json")


def _token_from_file() -> str | None:
    path = _credentials_file_path()
    try:
        with open(path) as f:
            creds = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None

    token = creds.get("claudeAiOauth", {}).get("accessToken")
    if not token:
        return None

    expires_at = creds.get("claudeAiOauth", {}).get("expiresAt")
    if expires_at:
        try:
            expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
            if expiry <= datetime.now(tz=timezone.utc):  # noqa: UP017
                return None
        except (ValueError, AttributeError):
            pass

    return token


def _token_from_keychain() -> str | None:
    """Try macOS Keychain for the Claude Code credential."""
    try:
        result = subprocess.run(
            [
                "security",
                "find-generic-password",
                "-s",
                "Claude Code-credentials",
                "-w",
            ],
            capture_output=True,
            text=True,
            timeout=3,
        )
        if result.returncode == 0:
            raw = result.stdout.strip()
            if not raw:
                return None
            # The keychain value may be a JSON blob
            try:
                creds = json.loads(raw)
                token = creds.get("claudeAiOauth", {}).get("accessToken")
                if not token:
                    return None
                expires_at = creds.get("claudeAiOauth", {}).get("expiresAt")
                if expires_at:
                    try:
                        expiry = datetime.fromisoformat(
                            expires_at.replace("Z", "+00:00")
                        )
                        if expiry <= datetime.now(tz=timezone.utc):  # noqa: UP017
                            return None
                    except (ValueError, AttributeError):
                        pass
                return token
            except json.JSONDecodeError:
                # Raw value is the token itself
                return raw if raw.startswith("sk-") else None
    except (OSError, subprocess.TimeoutExpired, FileNotFoundError):
        pass
    return None


def _get_access_token() -> str | None:
    """Return a valid OAuth access token, or None if unavailable."""
    token = _token_from_file()
    if token:
        return token
    return _token_from_keychain()


# ---------------------------------------------------------------------------
# API response parsing
# ---------------------------------------------------------------------------


def _parse_response(data: dict) -> dict[str, object]:
    """Transform raw API response to flat dict."""
    five_hour = data.get("five_hour", {})
    seven_day = data.get("seven_day", {})
    seven_day_sonnet = data.get("seven_day_sonnet", {})
    extra_usage = data.get("extra_usage", {})

    return {
        "five_hour_pct": five_hour.get("utilization"),
        "five_hour_resets_at": five_hour.get("resets_at"),
        "seven_day_pct": seven_day.get("utilization"),
        "seven_day_resets_at": seven_day.get("resets_at"),
        "seven_day_sonnet_pct": seven_day_sonnet.get("utilization"),
        "seven_day_sonnet_resets_at": seven_day_sonnet.get("resets_at"),
        "extra_usage_enabled": extra_usage.get("is_enabled"),
    }


# ---------------------------------------------------------------------------
# HTTP fetch with circuit breaker
# ---------------------------------------------------------------------------


def _fetch_usage(token: str) -> dict | None:
    """Fetch usage from the API. Returns parsed dict on success, None on failure."""
    global _beta_disabled, _consecutive_failures, _backoff_until, _backoff_delay

    headers = {
        "Authorization": f"Bearer {token}",
        "User-Agent": "cc-statusline/1.0",
    }
    if not _beta_disabled:
        headers["anthropic-beta"] = BETA_HEADER

    req = urllib.request.Request(USAGE_API_URL, headers=headers)

    try:
        with urllib.request.urlopen(req, timeout=3) as resp:
            body = resp.read()
            data = json.loads(body)
            # Success: reset circuit breaker
            _consecutive_failures = 0
            _backoff_delay = CACHE_TTL
            _backoff_until = 0.0
            return _parse_response(data)

    except urllib.error.HTTPError as exc:
        if exc.code == 400 and not _beta_disabled:
            # Beta header caused the error — disable and retry once
            _beta_disabled = True
            headers.pop("anthropic-beta", None)
            retry_req = urllib.request.Request(USAGE_API_URL, headers=headers)
            try:
                with urllib.request.urlopen(retry_req, timeout=3) as resp:
                    body = resp.read()
                    data = json.loads(body)
                    _consecutive_failures = 0
                    _backoff_delay = CACHE_TTL
                    _backoff_until = 0.0
                    return _parse_response(data)
            except (urllib.error.URLError, OSError, json.JSONDecodeError):
                pass
        elif exc.code == 429:
            _consecutive_failures += 1
        else:
            _consecutive_failures += 1

        # Update circuit breaker backoff
        if _consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
            _backoff_until = time.time() + _backoff_delay
            _backoff_delay = min(_backoff_delay * 2, 3600)

        return None

    except (urllib.error.URLError, OSError, json.JSONDecodeError):
        _consecutive_failures += 1
        if _consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
            _backoff_until = time.time() + _backoff_delay
            _backoff_delay = min(_backoff_delay * 2, 3600)
        return None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def get_usage() -> dict:
    """Return usage data dict. Returns _NONE_RESULT copy when data unavailable."""
    # Opt-out environment variable
    if os.environ.get("CLAUDE_STATUSLINE_NO_USAGE"):
        return dict(_NONE_RESULT)

    # Check circuit breaker
    if _backoff_until and time.time() < _backoff_until:
        cached = _read_cache()
        if cached is not None:
            return cached
        return dict(_NONE_RESULT)

    # Try cache first
    cached = _read_cache()
    if cached is not None:
        return cached

    # Need fresh data — get token (never cache token in memory)
    token = _get_access_token()
    if not token:
        return dict(_NONE_RESULT)

    result = _fetch_usage(token)
    if result is None:
        return dict(_NONE_RESULT)

    _write_cache(result)
    return result
