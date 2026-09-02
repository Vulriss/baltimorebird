from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

from .template import HTML_HEAD, HTML_FOOTER_SCRIPTS


class ReportBuilder:
    def __init__(self, title: str, author: str = "", source: str = ""):
        self.title = title
        self.author = author
        self.source = source
        self.created_at = datetime.now()
        self._blocks: list[Any] = []

    def add(self, component) -> "ReportBuilder":
        self._blocks.append(component)
        return self

    def _build_toc(self) -> str:
        entries = [
            f'<li><a href="#{b.anchor_id}"{" class=\"toc-h2\"" if b.level == 2 else ""}>{b.title}</a></li>'
            for b in self._blocks if b.__class__.__name__ == "Section" and b.level <= 2
        ]
        return "<ul>" + "".join(entries) + "</ul>"

    def _build_body(self) -> str:
        return "".join(block.render() for block in self._blocks)

    def save(self, output_path: str | Path) -> Path:
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)

        meta_html = (
            f'<div class="report-meta-item"><span>Generated : {self.created_at.strftime("%Y-%m-%d à %H:%M")}</span></div>'
            f'<div class="report-meta-item"><span>Author : {self.author}</span></div>'
            f'<div class="report-meta-item"><span>Source : {self.source}</span></div>'
        )

        html = HTML_HEAD.replace("{title}", self.title)
        html += (
            '<div class="report-container">'
            f'<header class="report-header"><h1>{self.title}</h1>'
            f'<div class="report-meta">{meta_html}</div></header>'
            '<div class="report-body">'
            f'<nav class="table-of-contents"><div class="toc-title">Table of Contents</div>{self._build_toc()}</nav>'
            f'<main class="report-content">{self._build_body()}</main>'
            '</div></div>'
        )
        html += HTML_FOOTER_SCRIPTS

        output_path.write_text(html, encoding="utf-8")
        return output_path