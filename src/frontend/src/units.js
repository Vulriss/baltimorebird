// Conversion d'unités affine: valeur_base = valeur * factor + offset.
// Chaque dimension regroupe les unités convertibles entre elles.
const DIMENSIONS = [
    { name: 'speed', units: {
        'm/s': [1, 0], 'mps': [1, 0],
        'km/h': [1 / 3.6, 0], 'kph': [1 / 3.6, 0], 'kmh': [1 / 3.6, 0],
        'mph': [0.44704, 0], 'kn': [0.514444, 0], 'knot': [0.514444, 0],
    } },
    { name: 'temperature', units: {
        'K': [1, 0],
        '°C': [1, 273.15], 'degC': [1, 273.15], 'C': [1, 273.15],
        '°F': [5 / 9, 255.3722222222], 'degF': [5 / 9, 255.3722222222], 'F': [5 / 9, 255.3722222222],
    } },
    { name: 'pressure', units: {
        'Pa': [1, 0], 'hPa': [100, 0], 'kPa': [1000, 0], 'MPa': [1e6, 0],
        'mbar': [100, 0], 'bar': [1e5, 0], 'psi': [6894.757293, 0],
    } },
    { name: 'angle', units: {
        'rad': [1, 0], '°': [Math.PI / 180, 0], 'deg': [Math.PI / 180, 0], 'degree': [Math.PI / 180, 0],
    } },
    { name: 'angularVelocity', units: {
        'rad/s': [1, 0],
        'rpm': [2 * Math.PI / 60, 0], '1/min': [2 * Math.PI / 60, 0], 'r/min': [2 * Math.PI / 60, 0],
        'rev/s': [2 * Math.PI, 0], 'deg/s': [Math.PI / 180, 0],
    } },
    { name: 'frequency', units: {
        'Hz': [1, 0], 'kHz': [1000, 0], 'MHz': [1e6, 0],
    } },
    { name: 'length', units: {
        'm': [1, 0], 'mm': [1e-3, 0], 'cm': [1e-2, 0], 'km': [1000, 0],
        'in': [0.0254, 0], 'ft': [0.3048, 0], 'mile': [1609.344, 0],
    } },
    { name: 'mass', units: {
        'kg': [1, 0], 'g': [1e-3, 0], 't': [1000, 0], 'lb': [0.45359237, 0],
    } },
    { name: 'time', units: {
        's': [1, 0], 'ms': [1e-3, 0], 'us': [1e-6, 0], 'min': [60, 0], 'h': [3600, 0],
    } },
    { name: 'voltage', units: {
        'V': [1, 0], 'mV': [1e-3, 0], 'kV': [1000, 0],
    } },
    { name: 'current', units: {
        'A': [1, 0], 'mA': [1e-3, 0], 'kA': [1000, 0],
    } },
    { name: 'power', units: {
        'W': [1, 0], 'kW': [1000, 0], 'MW': [1e6, 0], 'hp': [745.699872, 0], 'PS': [735.49875, 0],
    } },
    { name: 'torque', units: {
        'Nm': [1, 0], 'N·m': [1, 0], 'mNm': [1e-3, 0], 'kNm': [1000, 0],
    } },
];

const UNIT_INDEX = (() => {
    const index = {};
    for (const dim of DIMENSIONS) {
        for (const [unit, [factor, offset]] of Object.entries(dim.units)) {
            index[unit] = { dim: dim.name, factor, offset };
        }
    }
    return index;
})();

function lookup(unit) {
    return UNIT_INDEX[unit] || UNIT_INDEX[unit.toLowerCase()] || null;
}

// Retourne { factor, offset, targetUnit } pour convertir fromUnit -> toUnit,
// ou null si les unités sont de dimensions différentes ou inconnues.
// valeur_cible = valeur_source * factor + offset.
export function getUnitConversion(fromUnit, toUnit) {
    const from = (fromUnit || '').trim();
    const to = (toUnit || '').trim();
    if (from === to) {
        return { factor: 1, offset: 0, targetUnit: to, identity: true };
    }
    const a = lookup(from);
    const b = lookup(to);
    if (!a || !b || a.dim !== b.dim) {
        return null;
    }
    return {
        factor: a.factor / b.factor,
        offset: (a.offset - b.offset) / b.factor,
        targetUnit: to,
        identity: false,
    };
}
