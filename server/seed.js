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
