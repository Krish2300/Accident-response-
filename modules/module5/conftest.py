"""Shared pytest fixtures. Tests never call Gemini: MOCK_MODE is forced on,
and tests that exercise the Gemini path monkeypatch llm._call_gemini."""
from pathlib import Path

import pytest

PROTOCOL_DIR = Path(__file__).parent / "protocols"


@pytest.fixture(autouse=True)
def _mock_env(monkeypatch):
    monkeypatch.setenv("MOCK_MODE", "true")
    monkeypatch.delenv("SIMPLIFY_WITH_LLM", raising=False)
    monkeypatch.delenv("LLM_TIMEOUT_SECONDS", raising=False)


@pytest.fixture
def engine():
    from engine import ProtocolEngine
    return ProtocolEngine(PROTOCOL_DIR)


@pytest.fixture
def store():
    from engine import InMemorySessionStore
    return InMemorySessionStore()


@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    import app as app_module
    app_module.store.clear()
    return TestClient(app_module.app)
