# 油耗保養紀錄 — Android App

用 [Capacitor](https://capacitorjs.com) 把同一份網頁（`index.html`）包成 APK。網頁版（GitHub Pages）和 App 共用同一份程式碼，不需要維護兩套。

## 備份在 App 裡怎麼運作

備份層是一個介面（`backup.js` 的 `window.Backup`），依環境選一種實作：

| 環境 | 實作 | 行為 |
|---|---|---|
| Android App | `NativeBackup` | 每次修改後自動寫到「文件／VehicleLog」：`vehicle-log_latest.json` ＋ 當日檔（保留 7 天）。不用選資料夾、不會過期授權 |
| 瀏覽器 | `WebBackup` | 只能手動下載或分享 |

App 啟動時也會備份一次，寫入失敗時首頁會出現橫幅。匯出的 JSON／CSV 在 App 裡會直接存進同一個資料夾；「分享備份」「分享完整 CSV」會叫出系統分享選單，可傳到雲端硬碟或 LINE。

**重新安裝 App 後**：舊檔案還在「文件／VehicleLog」，但新安裝的 App 讀不到，請用「從備份還原」自己選檔。若新安裝寫不進同名舊檔，會自動改寫成帶識別碼的檔名（例如 `vehicle-log_latest_ab12.json`）。

另外 `android:allowBackup` 是開的，系統會把 App 資料備份到你的 Google 帳號（換手機時自動還原），只當保底，不要只靠它。

**和智慧記帳共用簽章金鑰**：同一把 keystore 可以簽多個 App，這個專案的 GitHub secrets 內容和智慧記帳一樣即可。兩個 App 的 appId 不同（`io.github.z88487561.vehiclelog`），所以可以同時安裝。

## 第一次設定簽章金鑰（重要，先做）

APK 要用**同一把金鑰**簽，之後的新版本才能直接覆蓋安裝。沒有固定金鑰就沒辦法更新，只能先解除安裝，**所有紀錄會跟著消失**。

```bash
keytool -genkeypair -v -keystore release.keystore -alias ledger \
  -keyalg RSA -keysize 2048 -validity 10000
# 金鑰密碼請和儲存庫密碼設成一樣
base64 -w0 release.keystore      # macOS：base64 -i release.keystore
```

到 GitHub 儲存庫 → Settings → Secrets and variables → Actions，新增四個 secret：

- `ANDROID_KEYSTORE_BASE64`：上面 base64 的輸出
- `ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_PASSWORD`：密碼
- `ANDROID_KEY_ALIAS`：`ledger`（沿用智慧記帳的金鑰就維持這個別名）

`release.keystore` 請另外備份到安全的地方（不要放進儲存庫）。弄丟就無法更新 App。

## 用 GitHub Actions 建置

1. 到儲存庫 Actions → **Build Android APK** → Run workflow（或推 `v1.0.0` 之類的標籤，會自動建立 Release 並附上 APK）。
2. 跑完後在該次執行的 Artifacts 下載 `vehicle-log-apk`，把 APK 傳到手機安裝（第一次要允許「安裝未知來源應用程式」）。
3. 改了 `index.html` 等網頁檔推上 `main`，也會自動重建。

## 本機建置

需要 Node 22、JDK 21、Android Studio（或 Android SDK）。

```bash
npm ci
npm run sync          # 複製網頁到 www/ 並同步進 android/
cd android && ./gradlew assembleDebug
# 或  npm run android:open  用 Android Studio 開啟
```

## 版本號

`package.json` 的 `version` 是顯示用的版本名稱；`versionCode` 由 CI 的執行編號自動遞增。

## 實機測試清單（還沒在真機上跑過，請逐項確認）

1. 新增一筆加油紀錄 → 用檔案管理員確認「文件／VehicleLog」出現 `vehicle-log_latest.json` 與當日檔。
2. 車輛資料 → 「匯出完整備份」「分享備份」「分享完整 CSV」「下載」「匯出單一車輛 CSV」都能用；CSV 用 Excel 開啟中文不亂碼。
3. 清除 App 資料後，用「從備份還原」選 `vehicle-log_latest.json` 能完整還原（車輛、加油、費用都在）。
4. 解除安裝再用同一把金鑰簽的 APK 重裝 → 還原後繼續記錄，確認備份橫幅沒有出現。
5. 掃描電子發票：相機權限、震動、補光、縮放。
6. Android 10 以下、Android 11～12 的機器若有，各測一次寫入（權限行為不同）。
