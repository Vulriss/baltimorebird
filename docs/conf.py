"""Configuration Sphinx pour la documentation utilisateur de Baltimore Bird."""

project = "Baltimore Bird"
author = "Geoffrey Domergue"
copyright = "2026, Geoffrey Domergue"
release = "1.1.0"

extensions = [
    "myst_parser",
    "sphinx_copybutton",
]

myst_enable_extensions = [
    "colon_fence",
    "deflist",
]

source_suffix = {
    ".md": "markdown",
}

exclude_patterns = ["_build", "Thumbs.db", ".DS_Store"]

html_theme = "furo"
html_title = "Baltimore Bird - User documentation"
html_static_path = ["_static"]
html_css_files = ["custom.css"]

html_theme_options = {
    "sidebar_hide_name": False,
}
