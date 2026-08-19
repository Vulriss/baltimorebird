// Baltimore Bird - Pont window.*: expose l'API attendue par les modules non-ESM
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md

import { S } from '../core/state.js';
import { extractBoolHighRanges } from './bool-zones.js';
import { init, initApp, initEDA, resizePlotCharts } from './bootstrap.js';
import { addMappingSlot, closeCreateVariableDrawer, closeCreateVariableModal, openComputedVariableForEdit, openCreateVariableDrawer, openCreateVariableModal, removeMappingSlot, setupCreateVariableListeners, submitCreateVariable } from './computed-vars.js';
import { ectx } from './context.js';
import { applyLayout, exportCurrentLayout } from './layout-state.js';
import { toggleExtendedZones, updatePlotHeader } from './plot-legend.js';
import { dropSignal, dropSignalGroup, removeSignalFromPlot, updateSignalsLoadedStatus } from './plots.js';
import { renderPlotFromCache } from './plot-ui.js';
import { ensureSignalPreloaded } from './preload.js';
import { changeSource, loadSources } from './sessions.js';
import { renderSignalList } from './signal-list.js';
import { closeUploadModal, handleEdaDbcSelect, handleEdaFileSelect, openUploadModal, removeEdaDbc, removeEdaFile, uploadEdaFile } from './upload.js';

// =========================================================================
// NE PAS appeler init() directement - ViewLoader s'en charge
// =========================================================================
// =========================================================================
// Expose globals for other modules (Vite compatibility)
// =========================================================================
window.initEDA = initEDA;

window.initApp = initApp;

window.init = init;

window.openUploadModal = openUploadModal;

window.closeUploadModal = closeUploadModal;

window.changeSource = changeSource;

window.resizePlotCharts = resizePlotCharts;

window.dropSignal = dropSignal;

window.dropSignalGroup = dropSignalGroup;

window.removeSignalFromPlot = removeSignalFromPlot;

window.handleEdaFileSelect = handleEdaFileSelect;

window.handleEdaDbcSelect = handleEdaDbcSelect;

window.removeEdaFile = removeEdaFile;

window.removeEdaDbc = removeEdaDbc;

window.uploadEdaFile = uploadEdaFile;

window.loadSources = loadSources;

window.renderSignalList = renderSignalList;

window.signalsInfo = S.signalsInfo;

window.openCreateVariableModal = openCreateVariableModal;

window.closeCreateVariableModal = closeCreateVariableModal;

window.openCreateVariableDrawer = openCreateVariableDrawer;

window.closeCreateVariableDrawer = closeCreateVariableDrawer;

window.openComputedVariableForEdit = openComputedVariableForEdit;

window.setupCreateVariableListeners = setupCreateVariableListeners;

window.addMappingSlot = addMappingSlot;

window.removeMappingSlot = removeMappingSlot;

window.submitCreateVariable = submitCreateVariable;

window.exportCurrentLayout = exportCurrentLayout;

window.applyLayout = applyLayout;

window.getSignalsInfo = () => S.signalsInfo;

window.currentLazySessionId = null;

// Sera mis à jour par changeSource
window.ensureSignalPreloaded = ensureSignalPreloaded;

window.updateSignalsLoadedStatus = updateSignalsLoadedStatus;

window.extendedBoolZones = ectx.extendedBoolZones;

window.toggleExtendedZones = toggleExtendedZones;

window.updatePlotHeader = updatePlotHeader;

window.renderPlotFromCache = renderPlotFromCache;

window.extractBoolHighRanges = extractBoolHighRanges;

window.disabledBoolZones = ectx.disabledBoolZones;

