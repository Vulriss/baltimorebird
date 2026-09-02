HTML_HEAD = """<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{title}</title>

    <!-- KaTeX for LaTeX rendering -->
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
    
    <style>
        :root {
            --bg-primary: #ffffff;
            --bg-secondary: #f8f9fa;
            --bg-tertiary: #e9ecef;
            --text-primary: #1a1a2e;
            --text-secondary: #666;
            --text-muted: #999;
            --border-color: #e0e0e0;
            --accent: #6366f1;
            --accent-light: rgba(99, 102, 241, 0.1);
            --success: #22c55e;
            --warning: #f59e0b;
            --danger: #ef4444;
        }
        
        [data-theme="dark"] {
            --bg-primary: #1a1a2e;
            --bg-secondary: #16162a;
            --bg-tertiary: #252550;
            --text-primary: #e0e0e0;
            --text-secondary: #aaa;
            --text-muted: #666;
            --border-color: #2d2d5a;
        }
        
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--bg-secondary);
            color: var(--text-primary);
            line-height: 1.6;
        }
        
        /* ===== Layout ===== */
        .report-container {
            max-width: 1100px;
            margin: 0 auto;
            background: var(--bg-primary);
            min-height: 100vh;
            box-shadow: 0 0 30px rgba(0,0,0,0.1);
        }
        
        .report-header {
            padding: 50px 60px 40px;
            border-bottom: 1px solid var(--border-color);
            background: linear-gradient(135deg, var(--bg-primary) 0%, var(--bg-secondary) 100%);
        }
        
        .report-header h1 {
            font-size: 2.5rem;
            font-weight: 700;
            margin-bottom: 12px;
            color: var(--text-primary);
        }
        
        .report-subtitle {
            font-size: 1.1rem;
            color: var(--text-secondary);
            margin-bottom: 20px;
        }
        
        .report-meta {
            display: flex;
            gap: 20px;
            flex-wrap: wrap;
            font-size: 0.9rem;
            color: var(--text-muted);
        }
        
        .report-meta-item {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        
        .report-meta-item svg {
            width: 16px;
            height: 16px;
            opacity: 0.7;
        }
        
        .report-body {
            display: flex;
            min-height: calc(100vh - 200px);
        }
        
        /* ===== Sidebar / TOC ===== */
        .table-of-contents {
            width: 260px;
            padding: 30px 20px;
            border-right: 1px solid var(--border-color);
            position: sticky;
            top: 0;
            height: 100vh;
            overflow-y: auto;
            flex-shrink: 0;
            background: var(--bg-secondary);
        }
        
        .toc-title {
            font-weight: 600;
            margin-bottom: 20px;
            color: var(--text-muted);
            text-transform: uppercase;
            font-size: 0.7rem;
            letter-spacing: 1.5px;
        }
        
        .table-of-contents ul {
            list-style: none;
        }
        
        .table-of-contents > ul > li {
            margin-bottom: 4px;
        }
        
        .table-of-contents a {
            display: block;
            color: var(--text-secondary);
            text-decoration: none;
            font-size: 0.9rem;
            padding: 6px 12px;
            border-radius: 6px;
            transition: all 0.2s;
            border-left: 2px solid transparent;
        }
        
        .table-of-contents a:hover {
            background: var(--accent-light);
            color: var(--accent);
        }
        
        .table-of-contents a.active {
            background: var(--accent-light);
            color: var(--accent);
            border-left-color: var(--accent);
            font-weight: 500;
        }
        
        .table-of-contents .toc-h2 {
            padding-left: 24px;
            font-size: 0.85rem;
        }
        
        /* ===== Main Content ===== */
        .report-content {
            flex: 1;
            padding: 40px 60px;
            min-width: 0;
        }
        
        /* ===== Typography ===== */
        h1, h2, h3, h4 {
            margin-top: 2.5rem;
            margin-bottom: 1rem;
            font-weight: 600;
        }
        
        h1:first-child, h2:first-child {
            margin-top: 0;
        }
        
        h1.section-title {
            font-size: 1.8rem;
            padding-bottom: 12px;
            border-bottom: 2px solid var(--accent);
            margin-bottom: 1.5rem;
        }
        
        h2 { font-size: 1.4rem; color: var(--text-primary); }
        h3 { font-size: 1.15rem; color: var(--text-secondary); }
        
        /* ===== Text Blocks ===== */
        .text-block {
            margin: 1.2rem 0;
            font-size: 1rem;
            line-height: 1.7;
        }
        
        .text-block p {
            margin-bottom: 0.8rem;
        }
        
        .text-block strong {
            color: var(--text-primary);
            font-weight: 600;
        }
        
        .text-block code {
            background: var(--bg-tertiary);
            padding: 2px 6px;
            border-radius: 4px;
            font-size: 0.9em;
            font-family: 'SF Mono', Monaco, 'Courier New', monospace;
        }
        
        /* ===== Key Metrics ===== */
        .metrics-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 16px;
            margin: 1.5rem 0;
        }
        
        .metric-card {
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 20px;
            text-align: center;
        }
        
        .metric-value {
            font-size: 2rem;
            font-weight: 700;
            color: var(--accent);
            line-height: 1.2;
        }
        
        .metric-label {
            font-size: 0.85rem;
            color: var(--text-secondary);
            margin-top: 4px;
        }
        
        .metric-card.success .metric-value { color: var(--success); }
        .metric-card.warning .metric-value { color: var(--warning); }
        .metric-card.danger .metric-value { color: var(--danger); }
        
        /* ===== Plot Containers ===== */
        .plot-container {
            margin: 2rem 0;
            border: 1px solid var(--border-color);
            border-radius: 12px;
            overflow: visible;
            background: var(--bg-primary);
        }
        
        .plot-container .plotly-graph-div {
            width: 100%;
        }
        
        .plot-container figcaption {
            padding: 12px 20px;
            background: var(--bg-secondary);
            font-size: 0.9rem;
            color: var(--text-secondary);
            border-top: 1px solid var(--border-color);
        }
        
        /* ===== Tables ===== */
        .table-container {
            margin: 1.5rem 0;
            overflow-x: auto;
            border: 1px solid var(--border-color);
            border-radius: 12px;
        }
        
        .table-container caption {
            text-align: left;
            font-weight: 600;
            padding: 16px 20px;
            background: var(--bg-secondary);
            border-bottom: 1px solid var(--border-color);
            font-size: 0.95rem;
        }
        
        .data-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 0.9rem;
        }
        
        .data-table th, .data-table td {
            padding: 12px 16px;
            text-align: left;
            border-bottom: 1px solid var(--border-color);
        }
        
        .data-table th {
            background: var(--bg-secondary);
            font-weight: 600;
            font-size: 0.8rem;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--text-secondary);
        }
        
        .data-table tbody tr:hover {
            background: var(--accent-light);
        }
        
        .data-table tbody tr:last-child td {
            border-bottom: none;
        }
        
        .table-note {
            font-size: 0.8rem;
            color: var(--text-muted);
            padding: 10px 16px;
            background: var(--bg-secondary);
            border-top: 1px solid var(--border-color);
        }
        
        /* Status badges in tables */
        .status-badge {
            display: inline-block;
            padding: 3px 10px;
            border-radius: 20px;
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
        }
        
        .status-badge.ok { background: rgba(34, 197, 94, 0.15); color: var(--success); }
        .status-badge.warning { background: rgba(245, 158, 11, 0.15); color: var(--warning); }
        .status-badge.error { background: rgba(239, 68, 68, 0.15); color: var(--danger); }
        
        /* ===== LaTeX ===== */
        .latex-display {
            margin: 2rem 0;
            padding: 20px;
            background: var(--bg-secondary);
            border-radius: 8px;
            text-align: center;
            overflow-x: auto;
        }
        
        .latex-inline {
            display: inline;
        }
        
        /* ===== Images ===== */
        .image-container {
            margin: 2rem 0;
            text-align: center;
        }
        
        .image-container img {
            max-width: 100%;
            height: auto;
            border-radius: 8px;
            border: 1px solid var(--border-color);
        }
        
        .image-container figcaption {
            margin-top: 12px;
            font-size: 0.9rem;
            color: var(--text-secondary);
        }
        
        /* ===== Collapsible ===== */
        .collapsible {
            border: 1px solid var(--border-color);
            border-radius: 12px;
            margin: 1.5rem 0;
            overflow: hidden;
        }
        
        .collapsible summary {
            padding: 16px 20px;
            cursor: pointer;
            font-weight: 500;
            background: var(--bg-secondary);
            display: flex;
            align-items: center;
            justify-content: space-between;
            transition: background 0.2s;
            list-style: none;
        }
        
        .collapsible summary::-webkit-details-marker {
            display: none;
        }
        
        .collapsible summary::after {
            content: '▼';
            font-size: 0.7rem;
            transition: transform 0.2s;
            color: var(--text-muted);
        }
        
        .collapsible[open] summary::after {
            transform: rotate(180deg);
        }
        
        .collapsible summary:hover {
            background: var(--bg-tertiary);
        }
        
        .collapsible-content {
            padding: 20px;
            border-top: 1px solid var(--border-color);
        }
        
        /* ===== Columns ===== */
        .columns-container {
            display: flex;
            gap: 24px;
            margin: 1.5rem 0;
        }
        
        .column {
            flex: 1;
            min-width: 0;
        }
        
        /* ===== Alerts/Callouts ===== */
        .callout {
            padding: 16px 20px;
            border-radius: 8px;
            margin: 1.5rem 0;
            display: flex;
            gap: 12px;
            align-items: flex-start;
        }
        
        .callout svg {
            width: 20px;
            height: 20px;
            flex-shrink: 0;
            margin-top: 2px;
        }
        
        .callout-content {
            flex: 1;
        }
        
        .callout-title {
            font-weight: 600;
            margin-bottom: 4px;
        }
        
        .callout.info {
            background: rgba(99, 102, 241, 0.1);
            border: 1px solid rgba(99, 102, 241, 0.3);
            color: var(--accent);
        }
        
        .callout.success {
            background: rgba(34, 197, 94, 0.1);
            border: 1px solid rgba(34, 197, 94, 0.3);
            color: var(--success);
        }
        
        .callout.warning {
            background: rgba(245, 158, 11, 0.1);
            border: 1px solid rgba(245, 158, 11, 0.3);
            color: var(--warning);
        }
        
        .callout.danger {
            background: rgba(239, 68, 68, 0.1);
            border: 1px solid rgba(239, 68, 68, 0.3);
            color: var(--danger);
        }
        
        /* ===== Code Blocks ===== */
        .code-block {
            background: #1e1e2e;
            color: #cdd6f4;
            padding: 20px;
            border-radius: 8px;
            margin: 1.5rem 0;
            overflow-x: auto;
            font-family: 'SF Mono', Monaco, 'Courier New', monospace;
            font-size: 0.85rem;
            line-height: 1.5;
        }
        
        /* ===== Theme Toggle ===== */
        .theme-toggle {
            position: fixed;
            bottom: 20px;
            right: 20px;
            width: 48px;
            height: 48px;
            border-radius: 50%;
            background: var(--bg-tertiary);
            border: 1px solid var(--border-color);
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            transition: all 0.2s;
            z-index: 100;
        }
        
        .theme-toggle:hover {
            transform: scale(1.1);
        }
        
        .theme-toggle svg {
            width: 24px;
            height: 24px;
            color: var(--text-primary);
        }
        
        /* ===== Print Styles ===== */
        @media print {
            .table-of-contents, .theme-toggle {
                display: none;
            }
            
            .report-container {
                box-shadow: none;
                max-width: none;
            }
            
            .report-body {
                display: block;
            }
            
            .plot-container, .collapsible {
                break-inside: avoid;
            }
        }
        
        /* ===== Responsive ===== */
        @media (max-width: 900px) {
            .report-body {
                flex-direction: column;
            }
            
            .table-of-contents {
                width: 100%;
                height: auto;
                position: static;
                border-right: none;
                border-bottom: 1px solid var(--border-color);
            }
            
            .report-header, .report-content {
                padding: 30px;
            }
            
            .columns-container {
                flex-direction: column;
            }
            
            .report-header h1 {
                font-size: 1.8rem;
            }
        }
    </style>
</head>"""

HTML_FOOTER_SCRIPTS = """<!-- Theme Toggle Button -->
    <button class="theme-toggle" onclick="toggleTheme()" title="Toggle dark mode">
        <svg class="sun-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="5"/>
            <line x1="12" y1="1" x2="12" y2="3"/>
            <line x1="12" y1="21" x2="12" y2="23"/>
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
            <line x1="1" y1="12" x2="3" y2="12"/>
            <line x1="21" y1="12" x2="23" y2="12"/>
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
        </svg>
    </button>
    
    <!-- Scripts -->
    <script src="https://cdn.plot.ly/plotly-2.27.0.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
    
    <script>
        // Initialize Plotly charts	
        document.addEventListener("DOMContentLoaded", () => {
            const theme = document.documentElement.getAttribute('data-theme');

            document.querySelectorAll('.plotly-graph-div').forEach(container => {
                const script = container.querySelector('script[type="application/json"]');
                if (!script) return;

                const figure = JSON.parse(script.textContent);
                script.remove();

                // Fusionne les couleurs du thème DANS le layout initial,
                // au lieu de les appliquer après coup (ce qui causait le flash).
                const themedLayout = Object.assign({}, figure.layout, PLOTLY_THEMES[theme]);

                Plotly.newPlot(
                    container,
                    figure.data,
                    themedLayout,
                    figure.config || { responsive: true }
                );
            });
        });
                
        // Initialize KaTeX
        document.querySelectorAll('[data-latex]').forEach(el => {
            try {
                katex.render(el.dataset.latex, el, {
                    displayMode: el.classList.contains('latex-display'),
                    throwOnError: false
                });
            } catch (e) {
                console.error('Error rendering LaTeX:', e);
                el.textContent = el.dataset.latex;
            }
        });
        
        // TOC scroll highlighting
        const tocLinks = document.querySelectorAll('.table-of-contents a');
        const sections = document.querySelectorAll('[id]');
        
        function updateTocHighlight() {
            let current = '';
            sections.forEach(section => {
                const rect = section.getBoundingClientRect();
                if (rect.top <= 100) {
                    current = section.id;
                }
            });
            
            tocLinks.forEach(link => {
                link.classList.toggle('active', link.getAttribute('href') === '#' + current);
            });
        }
        
        window.addEventListener('scroll', updateTocHighlight);
        updateTocHighlight();
        
        // Theme toggle
        function toggleTheme() {
            const html = document.documentElement;
            const currentTheme = html.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            html.setAttribute('data-theme', newTheme);
            localStorage.setItem('report-theme', newTheme);

            applyPlotlyTheme(newTheme);
            
            // Update Plotly charts for theme
            const plotBg = newTheme === 'dark' ? '#1a1a2e' : 'white';
            const gridColor = newTheme === 'dark' ? '#2d2d5a' : '#e0e0e0';
            const fontColor = newTheme === 'dark' ? '#e0e0e0' : '#1a1a2e';
            
            document.querySelectorAll('.plotly-graph-div > div').forEach(div => {
                Plotly.relayout(div, {
                    'plot_bgcolor': plotBg,
                    'paper_bgcolor': plotBg,
                    'font.color': fontColor,
                    'xaxis.gridcolor': gridColor,
                    'yaxis.gridcolor': gridColor
                });
            });
        }
        
        // Restore theme preference
        const savedTheme = localStorage.getItem('report-theme');
        if (savedTheme) {
            document.documentElement.setAttribute('data-theme', savedTheme);
        }
        
        // Smooth scroll for TOC links
        tocLinks.forEach(link => {
            link.addEventListener('click', e => {
                e.preventDefault();
                const targetId = link.getAttribute('href').slice(1);
                const target = document.getElementById(targetId);
                if (target) {
                    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            });
        });

        const PLOTLY_THEMES = {
            light: {
                plot_bgcolor: "white",
                paper_bgcolor: "white",
                font: { color: "#1a1a2e" },
                xaxis: {
                    gridcolor: "#e0e0e0",
                    zerolinecolor: "#e0e0e0"
                },
                yaxis: {
                    gridcolor: "#e0e0e0",
                    zerolinecolor: "#e0e0e0"
                }
            },
            dark: {
                plot_bgcolor: "#1a1a2e",
                paper_bgcolor: "#1a1a2e",
                font: { color: "#e0e0e0" },
                xaxis: {
                    gridcolor: "#2d2d5a",
                    zerolinecolor: "#2d2d5a"
                },
                yaxis: {
                    gridcolor: "#2d2d5a",
                    zerolinecolor: "#2d2d5a"
                }
            }
        };

        function applyPlotlyTheme(theme) {
            document.querySelectorAll('.plotly-graph-div.js-plotly-plot').forEach(div => {
                Plotly.relayout(div, PLOTLY_THEMES[theme]);
            });
        };

        PLOTLY_THEMES.dark.hoverlabel = {
            bgcolor: "#252550",
            font: { color: "#e0e0e0" }
        };
    </script>
</body>
</html>""" 

