// Contenu de la visite d'accueil. Ce module est purement declaratif: il ne
// connait que des selecteurs CSS, jamais le DOM ni les autres modules. Ajouter
// une etape = ajouter une entree dans TOUR_STEPS, sans toucher a l'orchestration.

// Incrementer a chaque evolution du parcours pour reproposer la visite aux
// utilisateurs qui avaient deja vu la version precedente.
export const ONBOARDING_VERSION = 1;

export const DOCUMENTATION_URL = 'https://baltimorebird.readthedocs.io/';

export const ICONS = {
    welcome: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z',
    import: 'M12 16V4M7 9l5-5 5 5M4 20h16',
    search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
    plot: 'M3 3v18h18M18 9l-5 5-4-4-3 3',
    control: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
    navigate: 'M5 12h14M9 8l-4 4 4 4M15 8l4 4-4 4',
    cursors: 'M7 3v18M17 3v18M7 12h10',
    share: 'M4 13v6a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6M12 15V3M8 7l4-4 4 4',
    finish: 'M20 6L9 17l-5-5',
};

export const WELCOME_STEP = {
    id: 'welcome',
    icon: ICONS.welcome,
        title: 'Bienvenue dans Baltimore Bird',
    lead: 'Analysez vos acquisitions vehicule dans le navigateur, du fichier brut au graphique partageable.',
    outline: [
        { title: 'Chargez un fichier', detail: 'MF4, DAT, BLF ou CSV' },
        { title: 'Trouvez vos signaux', detail: 'Recherche multi-mots, joker et regex' },
        { title: 'Tracez-les', detail: 'Glisser-deposer vers les graphiques' },
        { title: 'Analysez', detail: 'Curseurs, mutateurs, variables calculees' },
    ],
    primaryLabel: 'Commencer la visite',
    secondaryLabel: 'Explorer sans la visite',
};

export const TOUR_STEPS = [
    {
        id: 'import',
        reveal: ['#sidebarFiles'],
        icon: ICONS.import,
        shortTitle: 'Chargez une acquisition',
        title: 'Chargez une acquisition',
                paragraphs: [
            'Importez un fichier MF4, DAT, BLF ou CSV de 5 Go maximum depuis votre poste, ou collez-le depuis le presse-papiers.',
            'Un BLF a besoin de son ARXML ou de son DBC pour etre decode.',
        ],
        note: 'Le decodage d\'un BLF accompagne d\'un ARXML peut prendre plusieurs minutes.',
        interaction: {
            task: 'Chargez un fichier, ou restez sur la source de demonstration deja disponible.',
            done: 'Source chargee.',
            watch: { selectors: ['#sourceSelector'], events: ['change'], condition: 'has-value' },
        },
        targets: [
            {
                selectors: ['#uploadBtnAuth', '#uploadBtnGuest', '.sidebar-files .upload-btn'],
                label: 'Commencez ici',
                padding: 6,
                radius: 8,
            },
        ],
    },
    {
        id: 'search',
        reveal: ['#sidebarSignals'],
        icon: ICONS.search,
        shortTitle: 'Trouvez vos signaux',
        title: 'Trouvez vos signaux',
                paragraphs: [
            'Filtrez la liste avec plusieurs mots-cles separes par des espaces, le joker * ou une expression reguliere.',
            'L\'ordre des mots-cles n\'a pas d\'importance : couple moteur donne le meme resultat que moteur couple.',
        ],
        interaction: {
            task: 'Saisissez une recherche dans la liste des signaux.',
            done: 'Liste filtree.',
            watch: { selectors: ['#search'], events: ['input', 'change'], condition: 'non-empty-value' },
            suggestion: {
                label: 'Essayer temp',
                selectors: ['#search'],
                value: 'temp',
                event: 'input',
            },
        },
        targets: [
            {
                selectors: ['#search', '.sidebar-signals .search-box'],
                label: 'Filtrez ici',
                padding: 6,
                radius: 8,
            },
        ],
    },
    {
        id: 'plot',
        reveal: ['#sidebarSignals', '.tab-content.active'],
        icon: ICONS.plot,
        shortTitle: 'Tracez vos signaux',
        title: 'Tracez vos signaux',
                paragraphs: [
            'Glissez un signal vers la zone de droite pour l\'afficher dans le temps. Selectionnez-en plusieurs avec Ctrl ou Alt avant de les deposer.',
            'La bande Nouveau graphique, en bas, cree un panneau supplementaire dans l\'onglet courant.',
        ],
        targets: [
            {
                selectors: ['#signalList', '.sidebar-signals .signal-list'],
                label: 'Glissez depuis ici',
                padding: 6,
                radius: 10,
            },
            {
                selectors: ['.tab-content.active .drop-zone', '.drop-zone'],
                label: 'Nouveau graphique',
                padding: 6,
                radius: 10,
            },
        ],
        interaction: {
            task: 'Deposez un signal pour afficher votre premiere courbe.',
            done: 'Courbe affichee.',
            watch: {
                selectors: ['.tab-content.active .plot-legend', '.plot-legend'],
                events: ['mouseup', 'drop'],
                condition: 'exists',
            },
        },
    },
    {
        id: 'navigate',
        reveal: ['.tab-content.active'],
        icon: ICONS.navigate,
        shortTitle: 'Naviguez dans le temps',
        title: 'Naviguez dans le temps',
        interactive: true,
        paragraphs: [
            'Glissez sur la gouttiere de l\'axe X, sous le trace, pour deplacer la fenetre temporelle. Sur l\'axe Y, a gauche, glissez pour deplacer la plage et utilisez la molette pour la dilater.',
            'Dans la zone de trace, un glisser selectionne la plage a zoomer. Un double-clic ou Ctrl+Z revient a la vue precedente, Ctrl+Y la retablit.',
        ],
        note: 'Shift+Y recadre automatiquement l\'axe Y du panneau survole.',
        targets: [
            {
                selectors: ['.tab-content.active .u-over', '.tab-content.active .plots-wrapper'],
                label: 'Zoomez ici',
                padding: 8,
                radius: 8,
            },
        ],
    },
    {
        id: 'cursors',
        reveal: ['.tab-content.active', '.toolbar'],
        icon: ICONS.cursors,
        shortTitle: 'Mesurez avec les curseurs',
        title: 'Mesurez avec les curseurs',
        interactive: true,
        paragraphs: [
            'Ctrl + clic gauche dans le trace pose un curseur, le bouton de la barre d\'outils fait de meme. Posez-en plusieurs pour lire les ecarts entre instants.',
            'Glissez un curseur pour le deplacer. Le bouton des etiquettes affiche ou masque temps, delta et valeurs par courbe. La touche Suppr efface le dernier curseur manipule.',
        ],
        note: 'Les curseurs peuvent etre synchronises entre onglets depuis la barre d\'outils.',
        targets: [
            {
                selectors: ['#addCursorBtn', '#cursorLabelsToggle'],
                group: true,
                label: 'Curseurs et etiquettes',
                padding: 6,
                radius: 8,
            },
        ],
    },
    {
        id: 'control',
        reveal: ['#sidebarSignals', '.tab-content.active'],
        icon: ICONS.control,
        shortTitle: 'Personnalisez les courbes',
        title: 'Personnalisez les courbes',
        interactive: true,
        paragraphs: [
            'Depliez une ligne de legende pour regler la couleur, l\'epaisseur du trait et l\'interpolation du signal.',
            'Le champ Fonction applique un mutateur : derivee, filtrage Savitzky-Golay, KDE ou FFT. Les variables calculees se creent en bas de la liste des signaux.',
        ],
        targets: [
            {
                // Sans graphique trace, la legende n'existe pas encore: la cible est
                // simplement ignoree et l'etape s'affiche sans sa fleche.
                selectors: ['.tab-content.active .plot-legend', '.plot-legend'],
                label: 'Reglez ici',
                padding: 8,
                radius: 10,
            },
            {
                selectors: ['#createVariableBtn'],
                label: 'Creez ici',
                padding: 6,
                radius: 8,
            },
        ],
    },
    {
        id: 'share',
        reveal: ['.tab-content.active', '.nav-items'],
        icon: ICONS.share,
        shortTitle: 'Partagez vos resultats',
        title: 'Partagez vos resultats',
        interactive: true,
        paragraphs: [
            'L\'export de l\'onglet produit une image annotee : ajoutez fleches, cadres et texte avant d\'enregistrer, Ctrl+Z annule la derniere annotation.',
            'La vue Rapports rassemble les analyses generees, pour les relire et les transmettre.',
        ],
        link: { label: 'Ouvrir la documentation', href: DOCUMENTATION_URL },
        targets: [
            {
                selectors: ['.tab-content.active #exportPngBtn', '#exportPngBtn'],
                label: 'Exportez ici',
                padding: 6,
                radius: 8,
            },
            {
                selectors: ['.nav-item[data-view="reports"]'],
                label: 'Vos rapports',
                padding: 4,
                radius: 8,
            },
        ],
    },
];

export const FINISH_STEP = {
    id: 'finish',
    icon: ICONS.finish,
    title: 'Vous etes pret',
    lead: 'Vous connaissez le circuit complet : charger, chercher, tracer, regler.',
    paragraphs: [
        'Le bouton en forme de baguette, dans le menu lateral, relance cette visite a tout moment.',
    ],
    link: { label: 'Ouvrir la documentation', href: DOCUMENTATION_URL },
    primaryLabel: 'Terminer',
};

export const LABELS = {
    counter: (index, total) => `Etape ${index + 1} sur ${total}`,
    previous: 'Precedent',
    next: (shortTitle) => `Suivant : ${shortTitle}`,
    finish: 'Voir le bilan',
    skip: 'Passer la visite',
    close: 'Fermer la visite',
    dialog: 'Visite guidee de Baltimore Bird',
};
