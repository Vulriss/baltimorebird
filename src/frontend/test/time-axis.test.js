import { describe, it, expect } from 'vitest';
import {
    formatDuration, formatTimeOffset, formatTimeTicks, stepDecimals, timeAxisLayout, timeAxisSpace,
} from '../src/eda/time-axis.js';

// jsdom expose navigator.language = 'en-US': separateur decimal '.', milliers ','.

describe('stepDecimals', () => {
    it('returns the exact decimals of uPlot increments', () => {
        expect(stepDecimals(50)).toBe(0);
        expect(stepDecimals(1)).toBe(0);
        expect(stepDecimals(0.5)).toBe(1);
        expect(stepDecimals(0.025)).toBe(3);
        expect(stepDecimals(2.5 * 1e-5)).toBe(6);
        expect(stepDecimals(1e-7)).toBe(7);
    });

    it('returns 0 for degenerate steps', () => {
        expect(stepDecimals(0)).toBe(0);
        expect(stepDecimals(NaN)).toBe(0);
        expect(stepDecimals(-1)).toBe(0);
    });
});

describe('timeAxisLayout / formatTimeTicks', () => {
    it('keeps absolute seconds at usual zoom, decimals from the step', () => {
        const layout = timeAxisLayout(0, 600, 50);
        expect(layout.offset).toBeNull();
        expect(formatTimeTicks([0, 50, 100], layout)).toEqual(['0', '50', '100']);

        const half = timeAxisLayout(10, 12, 0.5);
        expect(formatTimeTicks([10, 10.5, 11], half)).toEqual(['10.0', '10.5', '11.0']);
    });

    it('stays absolute while labels fit in 7 significant digits', () => {
        const layout = timeAxisLayout(1234.0, 1234.5, 0.05);
        expect(layout.offset).toBeNull();
        expect(formatTimeTicks([1234.05], layout)).toEqual(['1,234.05']);
    });

    it('switches to relative SI labels with a round anchor on a deep zoom', () => {
        const layout = timeAxisLayout(1234.0005, 1234.0015, 1e-4);
        expect(layout.offset).toBeCloseTo(1234.0, 9);
        expect(layout.unitExp).toBe(-3);
        expect(formatTimeTicks([1234.0005, 1234.001, 1234.0015], layout))
            .toEqual(['+0.5 ms', '+1.0 ms', '+1.5 ms']);
        expect(formatTimeOffset(layout)).toBe('1,234.000 s +');
    });

    it('keeps absolute labels at 7 digits, µs relative labels beyond', () => {
        expect(timeAxisLayout(12.00010, 12.00060, 5e-5).offset).toBeNull();

        const layout = timeAxisLayout(12.000100, 12.000150, 5e-6);
        expect(layout.unitExp).toBe(-6);
        expect(formatTimeTicks([12.0001, 12.000105, 12.00015], layout)).toEqual(['+0 µs', '+5 µs', '+50 µs']);
        expect(formatTimeOffset(layout)).toBe('12.0001 s +');
    });

    it('never prints a negative zero from floating point noise', () => {
        const layout = timeAxisLayout(1234.0005, 1234.0015, 1e-4);
        const noisy = layout.offset - 1e-13;
        expect(formatTimeTicks([noisy], layout)).toEqual(['+0.0 ms']);
    });
});

describe('timeAxisSpace', () => {
    it('keeps uPlot default spacing for short labels', () => {
        expect(timeAxisSpace(null, 0, 0, 600, 1000)).toBe(50);
    });

    it('widens spacing when labels get longer', () => {
        expect(timeAxisSpace(null, 0, 1234.0, 1234.01, 1000)).toBeGreaterThan(50);
    });

    it('falls back to default on degenerate input', () => {
        expect(timeAxisSpace(null, 0, 5, 5, 1000)).toBe(50);
        expect(timeAxisSpace(null, 0, 0, 1, 0)).toBe(50);
    });
});

describe('formatDuration', () => {
    it('uses the SI prefix of the rounded duration', () => {
        expect(formatDuration(0.034, 3)).toBe('34 ms');
        expect(formatDuration(0.000018, 6)).toBe('18 µs');
        expect(formatDuration(0.0342, 4)).toBe('34.2 ms');
        expect(formatDuration(1.2344, 3)).toBe('1.234 s');
        expect(formatDuration(3e-9, 9)).toBe('3 ns');
    });

    it('rounds in seconds before choosing the unit', () => {
        expect(formatDuration(0.0009996, 3)).toBe('1 ms');
        expect(formatDuration(0.0000004, 3)).toBe('0 ms');
    });

    it('signs negative durations and never prints a negative zero', () => {
        expect(formatDuration(-0.034, 3)).toBe('−34 ms');
        expect(formatDuration(-1e-12, 6)).toBe('0 µs');
    });
});
