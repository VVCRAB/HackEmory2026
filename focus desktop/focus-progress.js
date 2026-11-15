const { sessionFeeCents } = require("./cancel-payment");

const SCORE = {
  completionPoints: 100,
  lookAwayPenalty: 3,
  blockedTabPenalty: 5,
  earlyExitPenalty: 15,
};
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const LOG_LIMIT = 8;

function createFocusProgress(getDatabase) {
  let current;
  let latest;
  let streak = 0;
  let weekStakeCents = 0;
  let earnedBreadcrumbCents = 0;

  function initialize() {
    const db = getDatabase();
    db.exec(`
      CREATE TABLE IF NOT EXISTS focus_results (
        id TEXT PRIMARY KEY,
        ended_at INTEGER NOT NULL,
        completed INTEGER NOT NULL,
        focused_seconds INTEGER NOT NULL,
        look_aways INTEGER NOT NULL,
        tabs_closed INTEGER NOT NULL,
        messages_handled INTEGER NOT NULL,
        score INTEGER NOT NULL,
        streak INTEGER NOT NULL,
        stake_cents INTEGER NOT NULL,
        reward_cents INTEGER NOT NULL DEFAULT 0
      )
    `);
    if (!db.prepare("PRAGMA table_info(focus_results)").all().some(column => column.name === "reward_cents")) {
      db.exec("ALTER TABLE focus_results ADD COLUMN reward_cents INTEGER NOT NULL DEFAULT 0");
    }
    earnedBreadcrumbCents = db.prepare("SELECT COALESCE(SUM(reward_cents), 0) AS total FROM focus_results").get().total;
    streak = db.prepare("SELECT streak FROM focus_results ORDER BY rowid DESC LIMIT 1").get()?.streak ?? 0;
    refreshStake();
  }

  function refreshStake() {
    weekStakeCents = getDatabase().prepare("SELECT COALESCE(SUM(stake_cents), 0) AS cents FROM focus_results WHERE ended_at >= ?")
      .get(Date.now() - WEEK_MS).cents;
  }

  function start(id, plannedSeconds) {
    current = { id, plannedSeconds, lookAways: 0, tabsClosed: 0, messagesHandled: 0, events: [] };
    refreshStake();
  }

  function record(id, counter, label) {
    if (!current || current.id !== id) return;
    if (counter) current[counter]++;
    current.events.unshift({ label, timestamp: Date.now() });
    if (current.events.length > LOG_LIMIT) current.events.pop();
  }

  function finish(id, remainingSeconds, completed, stakeCents = 0) {
    if (!current || current.id !== id) return;
    const { plannedSeconds, lookAways, tabsClosed, messagesHandled } = current;
    const focusedSeconds = plannedSeconds - remainingSeconds;
    const score = Math.max(0, Math.round(
      SCORE.completionPoints * focusedSeconds / plannedSeconds -
      SCORE.lookAwayPenalty * lookAways - SCORE.blockedTabPenalty * tabsClosed -
      (completed ? 0 : SCORE.earlyExitPenalty)
    ));
    const rewardCents = completed ? sessionFeeCents(plannedSeconds) : 0;
    const nextStreak = completed ? streak + 1 : 0;
    const endedAt = Date.now();
    getDatabase().prepare("INSERT INTO focus_results VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, endedAt, Number(completed), focusedSeconds, lookAways, tabsClosed,
        messagesHandled, score, nextStreak, stakeCents, rewardCents);
    earnedBreadcrumbCents += rewardCents;
    streak = nextStreak;
    latest = { id, completed, focusedSeconds, lookAways, tabsClosed, messagesHandled, score, streak, stakeCents, rewardCents };
    current = undefined;
    refreshStake();
  }

  function snapshot() {
    return { streak, weekStakeCents, earnedBreadcrumbCents, latest, events: current?.events ?? [] };
  }

  return { initialize, start, record, finish, snapshot };
}

module.exports = { createFocusProgress };
