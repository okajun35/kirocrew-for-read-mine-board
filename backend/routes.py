"""HTTP route table for the Redmine Board page.

Loaded as ``backend.routes:register_routes`` inside a synthetic package rooted
at the app directory, so imports are relative. No path parameters: GET takes
query strings, POST takes a JSON body.
"""

from dataclasses import dataclass
from typing import Callable

from . import handlers


@dataclass(frozen=True)
class Route:
    method: str
    path: str
    handler: Callable


def register_routes(ctx):
    sdk = getattr(ctx, "sdk_level", 0)
    if sdk < 1:
        health = getattr(ctx, "health", None)
        if health is not None:
            health.mark_degraded(
                f"redmine-board requires App Kit seam level 1 (owner gate); host provides {sdk}"
            )
    return [
        Route("GET", "/health", handlers.health),
        Route("GET", "/settings", handlers.get_settings),
        Route("POST", "/settings", handlers.save_settings),
        Route("POST", "/settings/test", handlers.test_connection),
        Route("GET", "/meta", handlers.meta),
        Route("GET", "/members", handlers.members),
        Route("GET", "/options", handlers.options),
        Route("GET", "/issues", handlers.search_issues),
        Route("GET", "/board", handlers.board),
        Route("GET", "/issue", handlers.get_issue),
        Route("GET", "/views", handlers.list_views),
        Route("POST", "/issue/status", handlers.update_status),
        Route("POST", "/issue/comment", handlers.add_comment),
        Route("POST", "/views", handlers.save_view),
        Route("POST", "/views/delete", handlers.delete_view),
    ]
