// Page publique de demande de suppression : appelle POST /api/auth/delete-account-public (mêmes règles que dans l'application).
const $ = (id) => document.getElementById(id);
$('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('msg'), btn = $('go');
  msg.className = ''; msg.textContent = ''; btn.disabled = true; btn.textContent = 'Suppression en cours…';
  try {
    const r = await fetch('/api/auth/delete-account-public', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: $('email').value, password: $('pw').value, confirm: $('confirm').value, deleteFamily: $('delFam').checked }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      $('f').reset(); $('familyBox').hidden = true;
      msg.className = 'ok';
      msg.textContent = j.familyDeleted ? 'Votre compte et votre famille (avec toutes ses données) ont été supprimés.' : 'Votre compte a été supprimé. La famille et ses données restent accessibles aux autres parents.';
    } else {
      if (j.code === 'family_will_be_deleted') $('familyBox').hidden = false;
      msg.className = 'warn'; msg.textContent = r.status === 429 ? 'Trop de tentatives : réessayez dans quelques minutes.' : (j.error || 'Erreur : la suppression n’a pas été effectuée.');
    }
  } catch { msg.className = 'warn'; msg.textContent = 'Connexion impossible : la suppression n’a pas été effectuée. Réessayez.'; }
  finally { btn.disabled = false; btn.textContent = 'Supprimer définitivement mon compte'; }
});
