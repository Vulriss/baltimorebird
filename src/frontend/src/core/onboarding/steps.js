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
        icon: ICONS.import,
        shortTitle: 'Chargez une acquisition',
        title: 'Chargez une acquisition',
                paragraphs: [
            'Importez un fichier MF4, DAT, BLF ou CSV de 5 Go maximum depuis votre poste, ou collez-le depuis le presse-papiers.',
            'Un BLF a besoin de son ARXML ou de son DBC pour etre decode.',
        ],
        note: 'Le decodage d\'un BLF accompagne d\'un ARXML peut prendre plusieurs minutes.',
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
        icon: ICONS.search,
        shortTitle: 'Trouvez vos signaux',
        title: 'Trouvez vos signaux',
                paragraphs: [
            'Filtrez la liste avec plusieurs mots-cles separes par des espaces, le joker * ou une expression reguliere.',
            'L\'ordre des mots-cles n\'a pas d\'importance : couple moteur donne le meme resultat que moteur couple.',
        ],
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
    },
    {
        id: 'control',
        icon: ICONS.control,
        shortTitle: 'Reglez et analysez',
        title: 'Reglez et analysez',
                paragraphs: [
            'La legende de chaque graphique regle l\'apparence signal par signal : interpolation, couleur, epaisseur et mutateurs (derivee, filtrage, KDE).',
            'Les variables calculees se creent depuis le bas de la liste des signaux.',
        ],
        link: { label: 'Ouvrir la documentation', href: DOCUMENTATION_URL },
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
