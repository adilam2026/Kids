// Bibliothèque initiale : suggestions modifiables, jamais des règles imposées.
const A = (theme, icon, title, value) => ({ theme, icon, title, value });
export const DEFAULT_ACTIONS = [
  A('Rangement', '🧸', 'Ranger ses jouets', 2),
  A('Rangement', '🛏️', 'Ranger sa chambre avec une aide adaptée', 3),
  A('Rangement', '🎒', 'Ranger ses affaires après une activité', 2),
  A('Autonomie', '👕', 'S’habiller avec l’aide adaptée à son âge', 2),
  A('Autonomie', '🛁', 'Faire sa toilette sous supervision adaptée', 2),
  A('Autonomie', '🪥', 'Se brosser les dents avec vérification du parent', 2),
  A('Vie de famille', '🍽️', 'Aider à mettre la table', 2),
  A('Vie de famille', '🤝', 'Aider son frère ou sa sœur', 3),
  A('Vie de famille', '🧺', 'Participer à une petite tâche familiale', 2),
  A('Relations et efforts', '⏳', 'Attendre son tour pendant un jeu', 2),
  A('Relations et efforts', '💪', 'Persévérer dans une activité difficile', 3),
  A('Relations et efforts', '💡', 'Prendre une initiative utile', 5),
  A('Malus facultatifs', '✋', 'Frapper ou pousser', -2),
  A('Malus facultatifs', '🔨', 'Abîmer volontairement un objet', -2),
];
export const DEFAULT_REWARDS = [
  { icon: '🎲', title: 'Choisir le jeu familial', cost: 10 },
  { icon: '📖', title: 'Choisir l’histoire du soir', cost: 15 },
  { icon: '🌳', title: 'Choisir une activité du week-end', cost: 30 },
];

export async function seedFamily(c, familyId) {
  let i = 0;
  for (const a of DEFAULT_ACTIONS) {
    await c.query(
      'INSERT INTO actions(family_id, theme, title, icon, value, sort) VALUES ($1,$2,$3,$4,$5,$6)',
      [familyId, a.theme, a.title, a.icon, a.value, i++],
    );
  }
  for (const r of DEFAULT_REWARDS) {
    await c.query('INSERT INTO rewards(family_id, title, icon, cost) VALUES ($1,$2,$3,$4)', [familyId, r.title, r.icon, r.cost]);
  }
}

// ---- Suggestions supplémentaires (proposées à toute famille, y compris existante) ----------
// Jamais appliquées automatiquement : le parent les prévisualise et choisit. `aliases` = anciens intitulés
// équivalents, pour ne pas créer de doublon avec une bibliothèque déjà en place.
export const SUGGESTED_ACTIONS = [
  { key: 'se-lever-rappel', theme: 'Autonomie', icon: '⏰', title: 'Se lever après le rappel du parent', value: 1 },
  { key: 's-habiller-aide', theme: 'Autonomie', icon: '👕', title: 'S’habiller avec une aide adaptée', value: 2, aliases: ['S’habiller avec l’aide adaptée à son âge'] },
  { key: 'ranger-jouets', theme: 'Rangement', icon: '🧸', title: 'Ranger ses jouets', value: 2 },
  { key: 'consigne-simple', theme: 'Relations et efforts', icon: '👂', title: 'Suivre une consigne simple', value: 1 },
  { key: 'entrer-en-classe', theme: 'École', icon: '🏫', title: 'Entrer en classe malgré son chagrin, même avec quelques larmes', value: 2 },
  { key: 'routine-coucher', theme: 'Autonomie', icon: '🌙', title: 'Faire la routine du coucher', value: 2 },
  // petits malus : à utiliser seulement après un rappel clair
  { key: 'malus-crier', theme: 'Malus facultatifs', icon: '📢', title: 'Continuer à crier sur quelqu’un', value: -1, malus: true },
  { key: 'malus-refus-consigne', theme: 'Malus facultatifs', icon: '🙅', title: 'Refuser une consigne simple et comprise', value: -1, malus: true },
  { key: 'malus-arracher-jouet', theme: 'Malus facultatifs', icon: '🪀', title: 'Arracher un jouet des mains', value: -1, malus: true },
  { key: 'malus-jeter-jouets', theme: 'Malus facultatifs', icon: '💥', title: 'Jeter volontairement ses jouets', value: -1, malus: true },
];
export const SUGGESTED_REWARDS = [
  { key: 'musique-voiture', icon: '🎵', title: 'Choisir la musique dans la voiture', cost: 5 },
  { key: 'jeu-familial', icon: '🎲', title: 'Choisir le jeu familial', cost: 10 },
  { key: 'activite-creative', icon: '🎨', title: 'Choisir une activité créative', cost: 10 },
  { key: 'histoire-en-plus', icon: '📖', title: 'Une histoire supplémentaire', cost: 10 },
  { key: 'bulles-jardin', icon: '🫧', title: 'Faire des bulles dans le jardin', cost: 15 },
  { key: 'gateau-ensemble', icon: '🎂', title: 'Préparer un gâteau ensemble', cost: 20 },
];
export const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// Compare le catalogue à l'existant (actions/récompenses, archivées comprises) : titre normalisé ou alias.
export async function suggestionStatus(c, familyId) {
  const acts = (await c.query('SELECT id, title, value, archived_at IS NOT NULL AS archived FROM actions WHERE family_id=$1', [familyId])).rows;
  const rws = (await c.query('SELECT id, title, cost, archived_at IS NOT NULL AS archived FROM rewards WHERE family_id=$1', [familyId])).rows;
  const find = (rows, s) => { const names = [s.title, ...(s.aliases || [])].map(norm); return rows.find((r) => names.includes(norm(r.title))); };
  const mapA = SUGGESTED_ACTIONS.map((s) => { const e = find(acts, s); return { ...s, existing: e ? { title: e.title, value: e.value, archived: e.archived } : null }; });
  const mapR = SUGGESTED_REWARDS.map((s) => { const e = find(rws, s); return { ...s, existing: e ? { title: e.title, cost: e.cost, archived: e.archived } : null }; });
  return { actions: mapA, rewards: mapR };
}
