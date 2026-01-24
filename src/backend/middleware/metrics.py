"""Baltimore Bird - Middleware de métriques."""

import time

from flask import Flask, Response, g, request

from services.metrics import metrics


def register_metrics_middleware(app: Flask) -> None:
    """Enregistre le middleware de métriques sur l'application Flask."""

    @app.before_request
    def before_request_metrics() -> None:
        g.start_time = time.time()
        ip = request.headers.get("X-Real-IP") or request.remote_addr or "unknown"
        g.session_id = metrics.get_or_create_session(ip)

    @app.after_request
    def after_request_metrics(response: Response) -> Response:
        if hasattr(g, "start_time"):
            latency_ms = (time.time() - g.start_time) * 1000
            ip = request.headers.get("X-Real-IP") or request.remote_addr or "unknown"

            if not request.path.startswith("/api/metrics"):
                metrics.record_request(
                    ip=ip,
                    endpoint=request.path,
                    method=request.method,
                    latency_ms=latency_ms,
                    status_code=response.status_code,
                )

        return response
