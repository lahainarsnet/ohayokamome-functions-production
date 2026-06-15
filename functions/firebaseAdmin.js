/**
 * 正本: github.com/lahainars/ohayou-kamome / cloud_functions/functions/
 *
 * 本番 app/no-app 対策:
 * - `firebase-admin` はルートの1モジュールのみ使用（サブパス require との AppStore 不一致を避ける）。
 * - `getApp()` の暗黙参照を避け、**初期化済み App インスタンスを1つ保持**し、
 *   firestore / messaging に **明示的に渡す**（Gen2 + onInit 周りでも default 参照に依存しない）。
 */
const admin = require("firebase-admin");

function ensureAdminApp() {
  if (!admin.apps.length) {
    admin.initializeApp();
  }
  return admin.app();
}

/** モジュール読込時に default アプリを確定（以降はこの参照のみ使用） */
const firebaseApp = ensureAdminApp();

let _db;
function getDb() {
  if (!_db) {
    _db = admin.firestore(firebaseApp);
  }
  return _db;
}

let _messaging;
function getMessagingClient() {
  if (!_messaging) {
    _messaging = admin.messaging(firebaseApp);
  }
  return _messaging;
}

let _auth;
function getAuthClient() {
  if (!_auth) {
    _auth = admin.auth(firebaseApp);
  }
  return _auth;
}

const out = {
  getDb,
  getMessagingClient,
  getAuthClient,
};

Object.defineProperty(out, "FieldValue", {
  configurable: true,
  enumerable: true,
  get() {
    return require("firebase-admin/firestore").FieldValue;
  },
});

Object.defineProperty(out, "Timestamp", {
  configurable: true,
  enumerable: true,
  get() {
    return require("firebase-admin/firestore").Timestamp;
  },
});

module.exports = out;
