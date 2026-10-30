const LXF_NS = 'http://www.asam.net/CEA/2008/LXF';
const UNIT_PER_FLEX = 100;
const CANVAS_WIDTH = 1000;
const DATA_COMPONENT = 'measurement';

// Donnees propres a Baltimore Bird portees par des processing instructions XML: hors
// schema LXF, ignorees par tout parseur conforme, relues par lxfToLayout.
const PI_LAYOUT = 'baltimorebird-layout';
const PI_SIGNAL = 'baltimorebird-signal';
const LXF_DASH = '4,4';

// "?>" ne peut apparaitre en JSON que dans une chaine, ou \u003e est un echappement valide.
function piXml(target, payload) {
    return `<?${target} ${JSON.stringify(payload).replace(/\?>/g, '?\\u003e')}?>`;
}

function readPi(parent, target) {
    const node = Array.from(parent.childNodes)
        .find(n => n.nodeType === 7 && n.target === target);
    if (!node) return null;
    try {
        const payload = JSON.parse(node.data);
        return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
    } catch {
        return null;
    }
}

function esc(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function dashToPenStyle(dash) {
    return dash ? 'dash' : 'solid';
}

function penStyleToDash(style) {
    return style === 'solid' ? '' : LXF_DASH;
}

// Ce que LXF ne sait pas representer: mutateur, trace, remplissage, motif de tirets exact.
function signalExtension(signal) {
    const style = signal.style || {};
    const ext = {};
    if (signal.transform) ext.transform = signal.transform;
    if (style.path) ext.path = style.path;
    if (style.fill) ext.fill = style.fill;
    if (style.dash && style.dash !== LXF_DASH) ext.dash = style.dash;
    return Object.keys(ext).length ? piXml(PI_SIGNAL, ext) : '';
}

function lineCurveXml(signal) {
    const style = signal.style || {};
    const color = esc(style.color || '#ffffff');
    const width = Number.isFinite(style.width) ? style.width : 1.5;
    return [
        '<LineCurve xmlns="" xAxisIndex="0" yAxisIndex="0">',
        signalExtension(signal),
        `<XInput component="${DATA_COMPONENT}" item="time"/>`,
        `<YInput component="${DATA_COMPONENT}" item="${esc(signal.name)}"/>`,
        `<Line style="${dashToPenStyle(style.dash)}" width="${width}">`,
        `<Color alpha="100" color="${color}"/>`,
        '</Line>',
        '</LineCurve>',
    ].join('');
}

function chartXml(plot, index, y, height) {
    const curves = plot.signals.map(lineCurveXml).join('');
    const axis = [
        '<XAxis xmlns="" scalingMode="auto">',
        `<Scaling xmlns="${LXF_NS}" type="linear"/>`,
        `<Ticks xmlns="${LXF_NS}"><MajorTicks delta="0" count="0"/><MinorTicks count="0"/></Ticks>`,
        '<Location x="0" y="0"/>',
        '</XAxis>',
        '<YAxis xmlns="" scalingMode="auto">',
        `<Scaling xmlns="${LXF_NS}" type="linear"/>`,
        `<Ticks xmlns="${LXF_NS}"><MajorTicks delta="0" count="0"/><MinorTicks count="0"/></Ticks>`,
        '<Location x="0" y="0"/>',
        '</YAxis>',
    ].join('');
    return [
        `<CartesianChart2D name="Plot ${index + 1}">`,
        '<Settings movable="true" resizable="true" modifiable="true" printable="true">',
        '<Bounds xmlns="">',
        `<Location x="0" y="${y}"/>`,
        `<Dimension xmlns="${LXF_NS}" height="${height}" width="${CANVAS_WIDTH}"/>`,
        '</Bounds>',
        '</Settings>',
        `<CartesianAxisSystem2D>${axis}</CartesianAxisSystem2D>`,
        `<CartesianCurveSet2D>${curves}</CartesianCurveSet2D>`,
        '<Legend><Font xmlns="" name="Arial" size="10"/></Legend>',
        '</CartesianChart2D>',
    ].join('');
}

function canvasXml(tab) {
    const plots = (tab.plots || []).filter(p => p.signals && p.signals.length > 0);
    let y = 0;
    const charts = plots.map((plot, index) => {
        const height = Math.max(1, Math.round((plot.flex || 1) * UNIT_PER_FLEX));
        const xml = chartXml(plot, index, y, height);
        y += height;
        return xml;
    }).join('');
    const ref = tab.name ? `<MasterLayoutRef name="${esc(tab.name)}"/>` : '';
    return `<Canvas columns="1" rows="1" pageFormat="A4"><GraphicSet>${charts}</GraphicSet>${ref}</Canvas>`;
}

export function layoutToLxf(doc) {
    const tabs = (doc && doc.tabs) || [];
    const predefinitions =
        '<Predefinitions>' +
        '<PageFormat name="A4" height="210" width="297" orientation="landscape">' +
        '<Margins top="10" right="10" left="10" bottom="10"/>' +
        '</PageFormat>' +
        '</Predefinitions>';
    const canvases = tabs.map(canvasXml).join('');
    const computed = (doc && doc.computed_variables) || [];
    const extension = computed.length ? piXml(PI_LAYOUT, { computed_variables: computed }) + '\n' : '';
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        extension +
        `<Layout version="1.0" xmlns="${LXF_NS}">` +
        predefinitions +
        canvases +
        '</Layout>\n'
    );
}

function childrenByName(parent, localName) {
    return Array.from(parent.children).filter(el => el.localName === localName);
}

function firstChild(parent, localName) {
    return childrenByName(parent, localName)[0] || null;
}

function curveToSignal(curve) {
    const yInput = firstChild(curve, 'YInput');
    const line = firstChild(curve, 'Line');
    const color = line && firstChild(line, 'Color');
    const ext = readPi(curve, PI_SIGNAL) || {};
    const signal = {
        name: yInput ? yInput.getAttribute('item') : '',
        style: {
            color: color ? color.getAttribute('color') : '#ffffff',
            width: line ? parseFloat(line.getAttribute('width')) || 1.5 : 1.5,
            dash: typeof ext.dash === 'string' ? ext.dash : (line ? penStyleToDash(line.getAttribute('style')) : ''),
            path: typeof ext.path === 'string' ? ext.path : '',
            fill: typeof ext.fill === 'string' ? ext.fill : '',
        },
    };
    if (ext.transform && typeof ext.transform === 'object') signal.transform = ext.transform;
    return signal;
}

function chartToPlot(chart) {
    const curveSet = firstChild(chart, 'CartesianCurveSet2D');
    const curves = curveSet ? childrenByName(curveSet, 'LineCurve') : [];
    const settings = firstChild(chart, 'Settings');
    const bounds = settings && firstChild(settings, 'Bounds');
    const dimension = bounds && firstChild(bounds, 'Dimension');
    const height = dimension ? parseFloat(dimension.getAttribute('height')) : UNIT_PER_FLEX;
    return {
        flex: (Number.isFinite(height) && height > 0 ? height : UNIT_PER_FLEX) / UNIT_PER_FLEX,
        signals: curves.map(curveToSignal).filter(s => s.name),
    };
}

export function lxfToLayout(xmlString) {
    const dom = new DOMParser().parseFromString(xmlString, 'application/xml');
    if (dom.getElementsByTagName('parsererror').length > 0) {
        throw new Error('XML invalide');
    }
    const root = dom.documentElement;
    if (!root || root.localName !== 'Layout' || root.namespaceURI !== LXF_NS) {
        throw new Error('Document LXF non reconnu');
    }
    const canvases = childrenByName(root, 'Canvas');
    const tabs = canvases.map((canvas, index) => {
        const ref = firstChild(canvas, 'MasterLayoutRef');
        const name = (ref && ref.getAttribute('name')) || `View ${index + 1}`;
        const graphicSet = firstChild(canvas, 'GraphicSet');
        const charts = graphicSet ? childrenByName(graphicSet, 'CartesianChart2D') : [];
        return { name, plots: charts.map(chartToPlot) };
    });
    const ext = readPi(dom, PI_LAYOUT) || readPi(root, PI_LAYOUT) || {};
    const computed = Array.isArray(ext.computed_variables) ? ext.computed_variables : [];
    return { tabs, computed_variables: computed };
}
