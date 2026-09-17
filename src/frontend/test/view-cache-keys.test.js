import { describe, it, expect, beforeEach } from 'vitest';
import { S } from '../src/core/state.js';
import { ectx } from '../src/eda/context.js';
import {
    getPersistentView, invalidateSignalCaches, prefetchCache, storeViewCache, viewKeyHasSignal,
} from '../src/eda/data-views.js';

// Cles au format viewKey: `${min}:${max}:${signaux}`, prefixees `${session}::` dans le
// cache persistant.

describe('viewKeyHasSignal', () => {
    it('matches a signal in the signals segment only', () => {
        expect(viewKeyHasSignal('12.5:40:3,17,4', 17)).toBe(true);
        expect(viewKeyHasSignal('12.5:40:3,17,4', 1)).toBe(false);
        expect(viewKeyHasSignal('17:40:3', 17)).toBe(false);
    });

    it('handles session prefixes and exponent or negative bounds', () => {
        expect(viewKeyHasSignal('sess-1::-1e-7:0.5:8', 8)).toBe(true);
        expect(viewKeyHasSignal('sess-1::-1e-7:0.5:8', 7)).toBe(false);
    });
});

describe('invalidateSignalCaches', () => {
    beforeEach(() => {
        ectx.currentLazySessionId = 'sess-1';
        S.runs = [];
    });

    it('drops cache, derived and views of the edited signal only', () => {
        const edited = { id: 1, signals: [5, 6], cachedData: { 5: {}, 6: {} }, _derivedCache: { 5: {} },
            viewCache: new Map([['0:1:5,6', {}], ['0:1:6', {}]]) };
        const other = { id: 2, signals: [6], cachedData: { 6: {} }, viewCache: new Map([['0:1:6', {}]]) };
        S.plots = [edited, other];

        expect(invalidateSignalCaches(5)).toEqual([edited]);
        expect(Object.keys(edited.cachedData)).toEqual(['6']);
        expect(edited._derivedCache[5]).toBeUndefined();
        expect([...edited.viewCache.keys()]).toEqual(['0:1:6']);
        expect(Object.keys(other.cachedData)).toEqual(['6']);
        expect(other.viewCache.size).toBe(1);
    });

    it('purges persistent views of the session and prefetched views', () => {
        const plot = { id: 1, signals: [5], cachedData: { 5: {} } };
        S.plots = [plot];
        storeViewCache(plot, '0:1:5', {}, 600);
        storeViewCache(plot, '0:1:6', {}, 600);
        prefetchCache.set('0:1:5', {});
        prefetchCache.set('0:1:6', {});

        invalidateSignalCaches(5);

        expect(getPersistentView('sess-1', '0:1:5')).toBeNull();
        expect(getPersistentView('sess-1', '0:1:6')).not.toBeNull();
        expect(prefetchCache.has('0:1:5')).toBe(false);
        expect(prefetchCache.has('0:1:6')).toBe(true);
    });

    it('returns no plot when the signal is not displayed', () => {
        S.plots = [{ id: 1, signals: [2], cachedData: { 2: {} } }];
        expect(invalidateSignalCaches(9)).toEqual([]);
    });
});
