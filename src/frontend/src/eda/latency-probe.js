// Baltimore Bird - latency probe of the EDA rendering chain.
//
// Off by default: every hook costs one boolean test. Once enabled (bbLatency.enable() in the
// console, or the latency harness in scripts/bench/latency), it records:
// - every plot render, with its data source ('server' view or 'client' cache), its duration,
//   its point count and whether all the plot's signals were complete (full resolution);
// - every data request (/view, /raw), with duration and payload size;
// - full-send events (start, end, skipped because the server view was already exact);
// - every global view frame (applyGlobalViewLocal): synchronous time, point selection, and
//   total main thread time including uPlot's deferred drawing.
// bbLatency.snapshot() returns copies of everything; timestamps are performance.now().
//
// No import on purpose: render, transforms and plot-ui all report here.

let enabled = false;
let renderSource = 'client';
let events = [];
let frames = [];
let frame = null;

export function latencyEnabled() {
    return enabled;
}

export function probeNow() {
    return enabled ? performance.now() : 0;
}

// Runs fn with `name` as the data source of the renders it triggers.
export function withRenderSource(name, fn) {
    const previous = renderSource;
    renderSource = name;
    try {
        return fn();
    } finally {
        renderSource = previous;
    }
}

function plotComplete(plot) {
    return plot.signals.every(i => plot.cachedData && plot.cachedData[i] && plot.cachedData[i].isComplete);
}

export function recordRender(plot, startedAt, points, series = null) {
    if (!enabled) return;
    const t = performance.now();
    events.push({
        type: 'render', t, plotId: plot.id, source: renderSource, ms: t - startedAt, points, series,
        complete: plotComplete(plot), bool: Boolean(plot.isBoolPlot),
    });
    if (frame) frame.draw += t - startedAt;
}

export function recordRequest(kind, startedAt, bytes) {
    if (!enabled) return;
    const t = performance.now();
    events.push({ type: 'request', kind, t, ms: t - startedAt, bytes });
}

export function recordEvent(type, plot, detail = null) {
    if (!enabled) return;
    events.push({ type, t: performance.now(), plotId: plot ? plot.id : null, detail });
}

export function recordSelection(startedAt) {
    if (enabled && frame) frame.select += performance.now() - startedAt;
}

export function frameStart() {
    if (enabled) frame = { t: performance.now(), select: 0, draw: 0 };
}

// uPlot draws in a microtask queued by setData, after the synchronous part of the frame: a
// microtask queued here runs after it, so `total` includes the drawing while `ms` does not.
export function frameEnd() {
    if (!enabled || !frame) return;
    const done = frame;
    done.ms = performance.now() - done.t;
    frames.push(done);
    frame = null;
    Promise.resolve().then(() => {
        done.total = performance.now() - done.t;
    });
}

window.bbLatency = {
    enable() {
        enabled = true;
    },
    disable() {
        enabled = false;
    },
    reset() {
        events = [];
        frames = [];
        frame = null;
    },
    snapshot() {
        return { events: events.slice(), frames: frames.slice() };
    },
};
