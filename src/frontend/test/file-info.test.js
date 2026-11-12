import { describe, it, expect, beforeEach } from 'vitest';
import { formatAcquisitionDuration, renderFileInfo, setFileStats } from '../src/eda/file-info.js';

// Fiche du fichier actif: duree lisible, stats et statut temporaire.

describe('formatAcquisitionDuration', () => {
    it('affiche les secondes sous la minute', () => {
        expect(formatAcquisitionDuration(0)).toBe('0 s');
        expect(formatAcquisitionDuration(42.4)).toBe('42 s');
    });

    it('affiche minutes et secondes sous l\'heure', () => {
        expect(formatAcquisitionDuration(60)).toBe('1 min 00 s');
        expect(formatAcquisitionDuration(557)).toBe('9 min 17 s');
    });

    it('abandonne les secondes au-dela de l\'heure', () => {
        expect(formatAcquisitionDuration(3600)).toBe('1 h 00 min');
        expect(formatAcquisitionDuration(4172.9)).toBe('1 h 09 min');
    });

    it('ramene une duree negative a zero', () => {
        expect(formatAcquisitionDuration(-3)).toBe('0 s');
    });
});

describe('fiche du fichier actif', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div id="sidebarInfo">
                <span id="fileInfoFormat" hidden></span><span id="fileInfoName"></span>
                <span id="statSignals">-</span>
                <span id="fileInfoDuration" hidden><span id="statDuration"></span></span>
                <div id="fileInfoStatus" hidden><button id="fileInfoLogin"></button></div>
            </div>`;
        delete window.currentUser;
    });

    it('formate le nombre de signaux et garde un champ absent', () => {
        setFileStats({ signals: 2466, duration: 557 });
        setFileStats({ signals: 1 });
        expect(document.getElementById('statSignals').textContent).toBe('1 signal');
        expect(document.getElementById('statDuration').textContent).toBe('9 min 17 s');
        expect(document.getElementById('fileInfoDuration').hidden).toBe(false);
        setFileStats({ signals: 2466 });
        expect(document.getElementById('statSignals').textContent.replace(/\s/g, ' ')).toBe('2 466 signaux');
    });

    it('masque une duree nulle, inconnue tant qu\'aucun signal n\'est charge', () => {
        setFileStats({ signals: 7, duration: 0 });
        expect(document.getElementById('fileInfoDuration').hidden).toBe(true);
        expect(document.getElementById('statDuration').textContent).toBe('');
    });

    it('signale un fichier temporaire et propose la connexion hors session', () => {
        renderFileInfo({ name: 'test_AMP', title: 'test_AMP.mf4', format: 'MF4', ephemeral: true });
        expect(document.getElementById('fileInfoName').textContent).toBe('test_AMP');
        expect(document.getElementById('fileInfoName').title).toBe('test_AMP.mf4');
        expect(document.getElementById('fileInfoFormat').hidden).toBe(false);
        expect(document.getElementById('fileInfoStatus').hidden).toBe(false);
        expect(document.getElementById('fileInfoLogin').hidden).toBe(false);
    });

    it('masque statut et badge vide pour une demo, et la connexion une fois connecte', () => {
        window.currentUser = { id: 1 };
        renderFileInfo({ name: 'test_AMP.mf4', format: 'MF4', ephemeral: true });
        expect(document.getElementById('fileInfoLogin').hidden).toBe(true);

        renderFileInfo({ name: 'Synthetic Data' });
        expect(document.getElementById('fileInfoFormat').hidden).toBe(true);
        expect(document.getElementById('fileInfoStatus').hidden).toBe(true);
    });
});
