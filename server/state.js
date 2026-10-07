import { config } from './config.js';
import { countFor } from './points.js';

export async function loadState(c, member, user) {
  const fam = member.familyId;
  const q = async (sql, p = [fam]) => (await c.query(sql, p)).rows;
  const [family] = await q('SELECT id, name, rev, quick_plus, quick_minus FROM families WHERE id=$1');
  const children = await q(`SELECT id, name, avatar, color, age, balance, archived_at IS NOT NULL AS archived FROM children WHERE family_id=$1 ORDER BY created_at`);
  const actions = await q(`SELECT id, theme, title, icon, value, note, min_interval_hours, favorite, child_ids, archived_at IS NOT NULL AS archived FROM actions WHERE family_id=$1 ORDER BY sort, created_at`);
  const rewards = await q(`SELECT id, title, icon, cost, child_ids, archived_at IS NOT NULL AS archived FROM rewards WHERE family_id=$1 ORDER BY cost, created_at`);
  const redemptions = await q(
    `SELECT id, reward_id, child_id, title, icon, cost, status, created_at, done_at, tx_id FROM redemptions
      WHERE family_id=$1 AND (status='todo' OR (status='done' AND done_at > now() - interval '30 days')) ORDER BY created_at DESC`);
  const members = await q(
    `SELECT u.id, u.name, u.email, m.role, m.status FROM members m JOIN users u ON u.id=m.user_id WHERE m.family_id=$1 ORDER BY m.created_at`);
  const day = (await c.query(`SELECT (now() AT TIME ZONE $1)::date AS d`, [config.timezone])).rows[0].d;
  const chRows = await q(`SELECT * FROM challenges WHERE family_id=$1 AND archived_at IS NULL ORDER BY created_at DESC`);
  const comps = await q(
    `SELECT challenge_id, child_id, event_id, day FROM challenge_completions WHERE family_id=$1 AND cancelled_at IS NULL`);
  const bonuses = await q(
    `SELECT b.challenge_id, b.child_id FROM challenge_bonuses b JOIN challenges c ON c.id=b.challenge_id WHERE c.family_id=$1 AND b.cancelled_at IS NULL`);
  const challenges = chRows.map((ch) => {
    const mine = comps.filter((k) => k.challenge_id === ch.id);
    const cnt = ch.collective
      ? [{ child_id: null, n: new Set(mine.map((k) => k.event_id)).size }]
      : ch.child_ids.map((id) => ({ child_id: id, n: mine.filter((k) => k.child_id === id).length }));
    const progress = {};
    const doneToday = {};
    for (const id of ch.child_ids) {
      progress[id] = countFor(cnt, ch, id);
      doneToday[id] = mine.some((k) => k.day === day && (ch.collective || k.child_id === id));
    }
    return {
      id: ch.id, title: ch.title, icon: ch.icon, actionId: ch.action_id, collective: ch.collective,
      childIds: ch.child_ids, startsOn: ch.starts_on, endsOn: ch.ends_on, target: ch.target,
      frequency: ch.frequency, bonus: ch.bonus, completed: !!ch.completed_at,
      expired: !ch.completed_at && ch.ends_on < day, upcoming: ch.starts_on > day,
      progress, doneToday, bonusGiven: bonuses.filter((b) => b.challenge_id === ch.id).map((b) => b.child_id),
    };
  });
  const pending = member.role === 'owner' ? await q(
    `SELECT id, expires_at, used_at IS NOT NULL AS used FROM invites WHERE family_id=$1 AND revoked_at IS NULL AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC`) : [];
  return {
    rev: family.rev, today: day,
    me: { id: user.id, name: user.name, email: user.email, role: member.role },
    family: { id: family.id, name: family.name, quickPlus: family.quick_plus, quickMinus: family.quick_minus },
    children, actions, rewards, redemptions, challenges, members, invites: pending,
  };
}
