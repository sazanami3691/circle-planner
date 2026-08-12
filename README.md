# circle-planner

iPadとPCで使う、24時間円形スケジュール管理用のローカルPWAです。予定は端末のブラウザ内へ保存され、日付ごとに円形表示できます。

## 起動方法

PWAとJavaScriptモジュールを正しく動かすため、ローカルサーバー経由で開きます。

```powershell
npm run serve
```

ブラウザで `http://127.0.0.1:8765` を開いてください。

## 確認

```powershell
npm run check
npm test
```

外部ライブラリやサーバー保存は使用していません。Googleカレンダー連携、通知、複数端末同期は今後の拡張対象です。
