"""Shared pytest fixtures for api/ tests."""

import pytest
from flask import Flask


@pytest.fixture
def app():
    """Bare Flask app, for tests exercising a handler via ``app.test_request_context``."""
    return Flask(__name__)
