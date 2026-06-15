# おはようカモメ Cloud Functions（再構築）

Android プロジェクト直下の **`cloud_functions/`** に、Firebase デプロイ用の一式を置いています。

- **`firebase.json`** … Functions のエントリ
- **`functions/index.js`** … ロジック本体（**通知 `channelId` 対応済み**＝`com.lahainars.tonikaku.new_message_alerts`）
- **`functions/package.json`** … `firebase-admin` / `firebase-functions` v2 用

`firebase_configs/index.js.txt` と同じ内容を `functions/index.js` にコピーした状態です。編集する場合はどちらか一方を正とし、デプロイ前に揃えてください。

## 初回だけ（プロジェクトを紐づける）

ターミナルでこのフォルダへ移動:

```bash
cd （このREADMEと同じ階層＝cloud_functions）
```

Firebase プロジェクトを選択（対話式）:

```bash
firebase use --add
```

表示された一覧から、**おはようカモメが使っている Firebase プロジェクト**を選ぶと、`.firebaserc` が作成されます。

## 依存インストールとデプロイ

```bash
cd functions
npm install
cd ..
firebase deploy --only functions
```

## 注意

- Cloud Functions の課金プラン（Blaze）が必要な場合があります。
- 既に同じプロジェクトに古い Functions がある場合、このデプロイで **上書き／追加**されます。関数名が同じなら置き換わります。
