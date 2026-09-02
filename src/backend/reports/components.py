"""Composants de rapport : chacun sait se rendre en fragment HTML."""
from __future__ import annotations

import re
from typing import Any, Optional

import pandas as pd

class Section:
    def __init__(self, title: str, level: int = 1):
        self.title = title
        self.level = level
        self.anchor_id = title.lower().replace(" ", "-").replace("_", "-")

    def render(self) -> str:
        tag = f"h{self.level}"
        cls = ' class="section-title"' if self.level == 1 else ""
        return f'<{tag}{cls} id="{self.anchor_id}">{self.title}</{tag}>'


class Text:
    def __init__(self, content: str):
        self.content = content

    def render(self) -> str:
        paragraphs = "".join(
            f"<p>{p}</p>" for p in self.content.strip().split("\n\n") if p.strip()
        )
        return f'<div class="text-block">{paragraphs}</div>'


class Callout:
    _ICONS = {
        "info": '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
        "success": '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
        "warning": '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
        "danger": '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    }

    def __init__(self, type: str, title: str, content: str):
        self.type = type if type in self._ICONS else "info"
        self.title = title
        self.content = content

    def render(self) -> str:
        icon = self._ICONS[self.type]
        return (
            f'<div class="callout {self.type}">'
            f'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">{icon}</svg>'
            f'<div class="callout-content"><div class="callout-title">{self.title}</div>'
            f'<div>{self.content}</div></div></div>'
        )


class Metrics:
    def __init__(self, items: list[tuple[str, Any]]):
        self.items = items

    def render(self) -> str:
        cards = "".join(
            f'<div class="metric-card"><div class="metric-value">{value}</div>'
            f'<div class="metric-label">{label}</div></div>'
            for label, value in self.items
        )
        return f'<div class="metrics-grid">{cards}</div>'


class Table:
    def __init__(self, df: pd.DataFrame, caption: str = "", max_rows: int = 20):
        self.df = df
        self.caption = caption
        self.max_rows = max_rows

    def render(self) -> str:
        shown = self.df.head(self.max_rows)
        html_table = shown.to_html(classes="data-table", index=False, border=0, na_rep="—")
        note = ""
        if len(self.df) > self.max_rows:
            note = f'<div class="table-note">Affichage de {self.max_rows} lignes sur {len(self.df)}.</div>'
        caption_html = f"<caption>{self.caption}</caption>" if self.caption else ""
        html_table = html_table.replace("<table", f"{caption_html}<table", 1)
        return f'<div class="table-container">{html_table}{note}</div>'


def _wrap_plotly(fig) -> str:
    return (
        '<figure class="plot-container"><div class="plotly-graph-div" style="height: 400px;">'
        f'<script type="application/json">{fig.to_json()}</script></div></figure>'
    )


class LinePlot:
    def __init__(self, df: pd.DataFrame, x: str, y: str, title: str = "", color: str = "#6366f1"):
        self.df, self.x, self.y, self.title, self.color = df, x, y, title, color

    def render(self) -> str:
        import plotly.graph_objects as go
        fig = go.Figure(go.Scatter(x=self.df[self.x], y=self.df[self.y], mode="lines",
                                    line=dict(color=self.color, width=2)))
        fig.update_layout(title=self.title, xaxis_title=self.x, yaxis_title=self.y,
                           margin=dict(t=50, b=50, l=60, r=30))
        return _wrap_plotly(fig)


class ScatterPlot:
    def __init__(self, df: pd.DataFrame, x: str, y: str, color: Optional[str] = None, title: str = ""):
        self.df, self.x, self.y, self.color, self.title = df, x, y, color, title

    def render(self) -> str:
        import plotly.graph_objects as go
        marker = dict(size=6, opacity=0.7)
        if self.color and self.color in self.df.columns:
            marker.update(color=self.df[self.color], colorscale="Viridis",
                           colorbar=dict(title=self.color))
        fig = go.Figure(go.Scatter(x=self.df[self.x], y=self.df[self.y], mode="markers", marker=marker))
        fig.update_layout(title=self.title, xaxis_title=self.x, yaxis_title=self.y,
                           margin=dict(t=50, b=50, l=60, r=30))
        return _wrap_plotly(fig)


class Histogram:
    def __init__(self, df: pd.DataFrame, column: str, bins: int = 30, title: str = ""):
        self.df, self.column, self.bins, self.title = df, column, bins, title

    def render(self) -> str:
        import plotly.graph_objects as go
        fig = go.Figure(go.Histogram(x=self.df[self.column], nbinsx=self.bins, marker_color="#14b8a6"))
        fig.update_layout(title=self.title, xaxis_title=self.column, yaxis_title="Count",
                           margin=dict(t=50, b=50, l=60, r=30))
        return _wrap_plotly(fig)


class StatsTable:
    def __init__(self, df: pd.DataFrame, signals: str = "*", caption: str = "Statistiques"):
        self.df, self.signals, self.caption = df, signals, caption

    def render(self) -> str:
        cols = list(self.df.columns) if self.signals == "*" else [
            c.strip() for c in self.signals.split(",") if c.strip() in self.df.columns
        ]
        stats = self.df[cols].describe().T.round(2).reset_index().rename(columns={"index": "Signal"})
        return Table(stats, caption=self.caption).render()


class LaTeX:
    def __init__(self, expression: str, display: bool = True):
        self.expression = expression
        self.display = display

    def render(self) -> str:
        cls = "latex-display" if self.display else "latex-inline"
        safe_expr = self.expression.replace('"', "&quot;")
        return f'<div class="{cls}" data-latex="{safe_expr}"></div>'