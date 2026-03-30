const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data', 'shyfacetime.db'));
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS call_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    caller_uid TEXT NOT NULL,
    caller_name TEXT NOT NULL,
    callee_uid TEXT NOT NULL,
    callee_name TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    duration_seconds INTEGER,
    was_missed INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS user_connections (
    user_a_uid TEXT NOT NULL,
    user_b_uid TEXT NOT NULL,
    total_calls INTEGER DEFAULT 1,
    last_call_at INTEGER NOT NULL,
    PRIMARY KEY (user_a_uid, user_b_uid)
  );
`);

// Prepared statements
const insertCall = db.prepare(`
  INSERT INTO call_history (caller_uid, caller_name, callee_uid, callee_name, started_at, was_missed)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const endCall = db.prepare(`
  UPDATE call_history SET ended_at = ?, duration_seconds = ? WHERE id = ?
`);

const upsertConnection = db.prepare(`
  INSERT INTO user_connections (user_a_uid, user_b_uid, total_calls, last_call_at)
  VALUES (?, ?, 1, ?)
  ON CONFLICT(user_a_uid, user_b_uid) DO UPDATE SET
    total_calls = total_calls + 1,
    last_call_at = excluded.last_call_at
`);

const getHistoryForUser = db.prepare(`
  SELECT * FROM call_history
  WHERE caller_uid = ? OR callee_uid = ?
  ORDER BY started_at DESC
  LIMIT 50
`);

const getConnectionsForUser = db.prepare(`
  SELECT * FROM user_connections
  WHERE user_a_uid = ? OR user_b_uid = ?
  ORDER BY last_call_at DESC
  LIMIT 50
`);

module.exports = {
  recordCallStart(callerUid, callerName, calleeUid, calleeName, wasMissed = 0) {
    const result = insertCall.run(callerUid, callerName, calleeUid, calleeName, Date.now(), wasMissed);
    return result.lastInsertRowid;
  },

  recordCallEnd(callId) {
    const now = Date.now();
    const call = db.prepare('SELECT started_at FROM call_history WHERE id = ?').get(callId);
    if (call) {
      const duration = Math.round((now - call.started_at) / 1000);
      endCall.run(now, duration, callId);
    }
  },

  recordConnection(uidA, uidB) {
    // Always store in sorted order so the pair is unique
    const [a, b] = [uidA, uidB].sort();
    upsertConnection.run(a, b, Date.now());
  },

  getHistory(uid) {
    return getHistoryForUser.all(uid, uid);
  },

  getConnections(uid) {
    return getConnectionsForUser.all(uid, uid);
  },

  recordMissedCall(callerUid, callerName, calleeUid, calleeName) {
    insertCall.run(callerUid, callerName, calleeUid, calleeName, Date.now(), 1);
  }
};
