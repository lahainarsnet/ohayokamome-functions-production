# 全体日次日報（daily_reports）設計

## 状態

- **コード実装済み**（Functions `dailyReport/` モジュール、管理Web UI/API）
- **production 未 deploy**（Functions / Scheduler / Rules / IAM 変更なし）
- **production write 未実施**（`daily_reports` コレクションは本番に未作成）

## コレクション

`daily_reports/{YYYY-MM-DD}` — JST 1日 = 1ドキュメント

## スキーマ（schemaVersion: 1）

| フィールド | 説明 |
|---|---|
| schemaVersion | 1 |
| reportDate | JST 日付キー |
| timezone | Asia/Tokyo |
| windowStartUtc / windowEndUtc | 集計ウィンドウ（UTC ISO） |
| status | processing / complete / partial / failed |
| generatedAt / regeneratedAt | 初回確定 / 再集計 |
| generation.source / generation.durationMs | scheduled / manual |
| completeness.activity / completeness.snapshot | 完全性 |
| activity | 当日フロー（increment） |
| snapshot | 日末スナップショット（EOD） |
| devices | 端末内訳（EOD） |
| quality | 品質・警告 |

## Activity（第1版）

- messaging: sentCount, receivedCount, sendBlocked.*
- stt: attemptCount, successCount, failureCount, limitExceededAttempts, failureByCode.*
- users: accountDeletions, tosAgreements（EOD クエリ）
- billing: subscriptionEvents（total / byPlatform / byType / byStatus）

## Snapshot（第1版）

- users: total, active, deleted
- billing: byStatus, byPlatform, entitlementUsable
- devices: byPlatform, byAppVersion, byBuildNumber（上位50+other）

## 集計方式

1. **Activity increment** — `sendMessageWithLimit`, `transcribeExperiment`, `deleteMyAccount`, 課金 webhook（非ブロッキング）
2. **EOD finalize** — `runScheduledDailyReportHandler` / `scheduledDailyReport`（JST D+1 00:20 想定）

再実行時: snapshot/devices を置換、activity は保持。

## 本番投入前の作業

1. Firestore Rules: `daily_reports` は Admin SDK / Functions SA のみ write
2. Functions deploy（`scheduledDailyReport` 含む）
3. Cloud Scheduler 作成（`20 0 * * *` Asia/Tokyo）
4. 管理Web deploy（日報 API/UI）
5. 初回 EOD 実行または手動 finalize の確認

## 禁止保存

message text, email, uid 一覧, deviceId, token 類, STT 本文/音声
