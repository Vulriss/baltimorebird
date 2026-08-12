// =========================================================================
// Code Editor Wrapper
// Fichier: js/code-editor.js
// 
// Wrapper pour Monaco Editor avec support Python et thème sombre
// Monaco a un support CDN natif et robuste
// =========================================================================

const CodeEditor = (function() {
    'use strict';

    const editors = new Map();
    let monacoLoaded = false;
    let loadPromise = null;

    // =========================================================================
    // Monaco Loading
    // =========================================================================

    async function loadMonaco() {
        if (monacoLoaded) return;
        if (loadPromise) return loadPromise;

        loadPromise = new Promise((resolve, reject) => {
            // Charger le loader Monaco
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs/loader.js';
            script.onload = () => {
                // Configurer le chemin vers les modules Monaco
                require.config({
                    paths: {
                        'vs': 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs'
                    }
                });

                // Charger Monaco
                require(['vs/editor/editor.main'], function() {
                    // Définir le thème Tokyo Night
                    monaco.editor.defineTheme('tokyo-night', {
                        base: 'vs-dark',
                        inherit: true,
                        rules: [
                            { token: 'comment', foreground: '565f89', fontStyle: 'italic' },
                            { token: 'keyword', foreground: 'bb9af7' },
                            { token: 'string', foreground: '9ece6a' },
                            { token: 'number', foreground: 'ff9e64' },
                            { token: 'type', foreground: '2ac3de' },
                            { token: 'function', foreground: '7aa2f7' },
                            { token: 'variable', foreground: 'c0caf5' },
                            { token: 'constant', foreground: 'ff9e64' },
                            { token: 'parameter', foreground: 'e0af68' },
                            { token: 'builtin', foreground: '7dcfff' },
                            { token: 'operator', foreground: '89ddff' },
                            { token: 'decorator', foreground: 'ff9e64' },
                        ],
                        colors: {
                            'editor.background': '#0a0a14',
                            'editor.foreground': '#a9b1d6',
                            'editor.lineHighlightBackground': '#1a1b26',
                            'editor.selectionBackground': '#6366f14d',
                            'editor.inactiveSelectionBackground': '#6366f133',
                            'editorCursor.foreground': '#c0caf5',
                            'editorLineNumber.foreground': '#3b3f5c',
                            'editorLineNumber.activeForeground': '#737aa2',
                            'editorIndentGuide.background': '#1a1b26',
                            'editorIndentGuide.activeBackground': '#3b3f5c',
                            'editor.selectionHighlightBackground': '#6366f133',
                            'editorBracketMatch.background': '#6366f133',
                            'editorBracketMatch.border': '#6366f1',
                            'scrollbarSlider.background': '#2d2d5a80',
                            'scrollbarSlider.hoverBackground': '#3d3d6a80',
                            'scrollbarSlider.activeBackground': '#4d4d7a80',
                        }
                    });

                    monacoLoaded = true;
                    console.log('Monaco Editor loaded successfully');
                    resolve();
                });
            };
            script.onerror = () => reject(new Error('Failed to load Monaco loader'));
            document.head.appendChild(script);
        });

        return loadPromise;
    }

    // =========================================================================
    // Editor Creation
    // =========================================================================

    async function create(container, options = {}) {
        await loadMonaco();

        const {
            value = '',
            onChange = null,
            minHeight = 150
        } = options;

        container.innerHTML = '';
        container.style.minHeight = `${minHeight}px`;

        const editor = monaco.editor.create(container, {
            value: value,
            language: 'python',
            theme: 'tokyo-night',
            fontSize: 13,
            fontFamily: "'Fira Code', 'SF Mono', Monaco, Consolas, monospace",
            fontLigatures: true,
            lineNumbers: 'on',
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 4,
            insertSpaces: true,
            wordWrap: 'on',
            lineHeight: 20,
            padding: { top: 12, bottom: 12 },
            renderLineHighlight: 'line',
            cursorBlinking: 'smooth',
            cursorSmoothCaretAnimation: 'on',
            smoothScrolling: true,
            bracketPairColorization: { enabled: true },
            guides: {
                indentation: true,
                bracketPairs: true
            },
            scrollbar: {
                vertical: 'auto',
                horizontal: 'auto',
                verticalScrollbarSize: 8,
                horizontalScrollbarSize: 8
            },
            overviewRulerLanes: 0,
            hideCursorInOverviewRuler: true,
            overviewRulerBorder: false,
        });

        // Listener pour les changements
        if (onChange) {
            editor.onDidChangeModelContent(() => {
                onChange(editor.getValue());
            });
        }

        const id = container.id || `editor_${Date.now()}`;
        if (!container.id) container.id = id;

        const instance = {
            editor,
            getValue: () => editor.getValue(),
            setValue: (newValue) => editor.setValue(newValue),
            focus: () => editor.focus(),
            destroy: () => {
                editor.dispose();
                editors.delete(id);
            }
        };

        editors.set(id, instance);
        return instance;
    }

    function get(id) {
        return editors.get(id) || null;
    }

    function destroy(id) {
        const instance = editors.get(id);
        if (instance) instance.destroy();
    }

    function destroyAll() {
        editors.forEach((instance) => instance.editor.dispose());
        editors.clear();
    }

    function isReady() {
        return monacoLoaded;
    }

    return { create, get, destroy, destroyAll, isReady, loadModules: loadMonaco };

})();
// =========================================================================
// Expose globals for other modules (Vite compatibility)
// =========================================================================
window.CodeEditor = CodeEditor;
