const LXF_NS = 'http://www.asam.net/CEA/2008/LXF';
const UNIT_PER_FLEX = 100;
const CANVAS_WIDTH = 1000;
const DATA_COMPONENT = 'measurement';

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
    return style === 'solid' ? '' : '4,4';
}

function lineCurveXml(signal) {
    const style = signal.style || {};
    const color = esc(style.color || '#ffffff');
    const width = Number.isFinite(style.width) ? style.width : 1.5;
    return [
        '<LineCurve xmlns="" xAxisIndex="0" yAxisIndex="0">',
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
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
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
    return {
        name: yInput ? yInput.getAttribute('item') : '',
        style: {
            color: color ? color.getAttribute('color') : '#ffffff',
            width: line ? parseFloat(line.getAttribute('width')) || 1.5 : 1.5,
            dash: line ? penStyleToDash(line.getAttribute('style')) : '',
            path: '',
            fill: '',
        },
    };
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
    return { tabs, computed_variables: [] };
}
