## 🎙️ 2026Podcast 批量下載與增強轉錄工具

一個用來「批量下載 Podcast 音檔」＋「使用 OpenAI Whisper 生成多格式逐字稿」的全端小工具。  
前端使用 React + TypeScript，後端使用 Node.js + Express，並整合 OpenAI Whisper API。

---

### 📁 專案位置與 GitHub

- **本機資料夾路徑**：`/Users/0xpeng/podcast批量下載`
- **GitHub 倉庫**：`https://github.com/0xpeng/podcastdownload2.0.git`

本機這個資料夾就是該 GitHub 專案的工作目錄（remote `origin` 指向上面這個網址）。

---

### ✨ 功能概要

- **RSS 解析**
  - 輸入 Podcast 的 RSS feed URL
  - 解析出各集的：標題、發布日期、時長、音檔連結
- **批量下載**
  - 可勾選多個集數
  - 支援直接下載與透過多個 CORS 代理下載
  - 自動依 Content-Type / 副檔名決定下載檔案的副檔名
- **音檔測試**
  - 測試單一集或全部集數的音檔連結是否有效
  - 顯示「有效 / 無效 / 測試中」標記，並可一鍵只選擇有效的集數
- **內建播放器**
  - 每一集有一個小型音訊播放器
  - 優先透過後端 `/api/download` 代理抓音檔 Blob 來播放，避免 CORS 問題
- **增強轉錄**
  - 針對單集或多集呼叫後端 `/api/transcribe`
  - 使用 OpenAI Whisper (`whisper-1`) 進行轉錄（預設繁體中文）
  - 支援多種輸出格式：TXT、SRT、VTT、JSON
  - 基本的「模擬說話者分離」與「智能分段／文字後處理」
  - 超過 Whisper 25MB 限制時，自動壓縮或分割音檔再分段轉錄

---

### 🧱 主要技術堆疊

- **前端**
  - React + TypeScript（Create React App）
  - 自訂音訊播放器、轉錄設定面板、集數列表與操作按鈕
- **後端**
  - Node.js + Express
  - `server.js`：API 入口
  - `transcription-service.js`：轉錄結果多格式輸出、分段優化、說話者分離模組
- **第三方服務**
  - OpenAI Whisper API（`whisper-1`，語音轉文字）

---

### 🚀 開發與啟動方式

#### 1. 安裝相依套件

```bash
cd /Users/0xpeng/podcast批量下載
npm install
```

#### 2. 設定環境變數

後端需要 OpenAI API Key 才能使用轉錄功能：

- 在終端機中匯出環境變數（macOS / Linux）：

```bash
export OPENAI_API_KEY="你的 OpenAI API Key"
```

（建議使用 `sk-proj-...` 開頭的新格式金鑰）

也可以把這行寫到你的 `~/.zshrc` 或其他 shell 設定檔裡。

#### 3. 開發模式（只跑前端）

這個模式適合調整 UI 或前端邏輯，API 可以另外用 `node server.js` 跑：

```bash
npm run dev
```

- 路徑：`http://localhost:3000`
- 注意：如果要在這個模式下用 `/api/...`，需要：
  - 另外開一個終端跑 `node server.js`，**或**
  - 在 `package.json` 設定 CRA 的 `proxy` 指到後端位址（目前預設沒有寫）。

#### 4. 全端模式（建議實際使用時）

這個模式會先打包前端，然後由 Express 直接提供靜態檔＋ API：

```bash
# 打包前端
npm run build

# 啟動後端（同時提供前端頁面＋ API）
npm start
```

- 伺服器預設在：`http://localhost:3000`
- `server.js` 會：
  - 啟動 Express API（`/api/download`、`/api/transcribe` 等）
  - 用 `express.static('build')` 服務打包後的 React 檔案

---

### 🔌 主要 API 說明（後端）

- **`POST /api/download`**  
  - 用途：從遠端 `audioUrl` 下載音檔，並直接回傳二進位檔案（供前端播放或後續上傳轉錄）。  
  - 請求 JSON：
    - `audioUrl`: 音檔 URL
    - `title`:（選填）用於組檔名

- **`POST /api/transcribe`**  
  - 用途：接收前端上傳的音檔 Blob，呼叫 OpenAI Whisper 做轉錄＋格式轉換。  
  - 表單欄位（`multipart/form-data`）：
    - `audio`: 音檔（blob）
    - `title`: 集數標題
    - `episodeId`: 集數 ID
    - `outputFormats`: 逗號分隔格式列表（例如：`txt,srt,vtt,json`）
    - `contentType`: `podcast | interview | lecture`
    - `enableSpeakerDiarization`: `true | false`

- **`POST /api/convert-transcript`**  
  - 用途：在已有轉錄結果的情況下，再轉成其他格式。  
  - 請求 JSON：
    - `transcriptData`: Whisper 的結果或兼容格式
    - `outputFormat`: `txt | srt | vtt | json`

- **`ALL /api/test`**  
  - 健康檢查，回傳 API 狀態、Node 版本、是否有設定 `OPENAI_API_KEY` 等。

---

### 🧩 重要檔案說明

- **`src/App.tsx`**
  - 前端主程式：RSS 解析、列表 UI、播放器、批量下載、轉錄設定與轉錄流程控制都在這裡。
- **`server.js`**
  - Express 伺服器入口，實作：
    - `POST /api/download`
    - `POST /api/transcribe`
    - `POST /api/convert-transcript`
    - `ALL /api/test`
  - 同時負責靜態檔服務（生產模式）。
- **`transcription-service.js`**
  - `TranscriptionFormatter`：SRT / VTT / JSON / TXT 輸出
  - `TranscriptionOptimizer`：提示詞優化、智能分段、文字後處理
  - `SpeakerDiarization`：模擬說話者分離（預留未來真實模型）
  - `TranscriptionProcessor`：把 Whisper 結果轉成多種格式並附上 metadata
- **`podcast-downloader/`、`podcast-downloader-app/`**
  - 舊版或實驗用的 CRA 子專案，目前主要邏輯在根目錄的 `src/` 與 `server.js`。

---

### ⚠️ 注意事項

- 轉錄功能必須有有效的 `OPENAI_API_KEY`，否則 `/api/transcribe` 會直接回傳錯誤。
- 大於 25MB 的音檔會觸發後端自動壓縮／切片流程，過程中需要 `ffmpeg`：
  - 請確認系統已安裝 `ffmpeg`，且命令列可呼叫：
    ```bash
    ffmpeg -version
    ```
  - 若 `ffmpeg` 不可用，超大檔案轉錄會失敗，後端會回傳具體錯誤與建議（例如手動壓縮、分割）。
- 部分 Podcast 平台可能有額外的反爬／防盜鏈機制，即使有 RSS 也可能無法直接拿到音檔連結，前端會在解析或下載失敗時顯示提示。

---

### ✅ 快速確認專案是否正常

1. 在專案根目錄執行：
   ```bash
   npm install
   npm run build
   export OPENAI_API_KEY="你的 OpenAI API Key"
   npm start
   ```
2. 開瀏覽器到 `http://localhost:3000`
3. 貼上一組 Podcast RSS URL，確認：
   - 能列出集數列表
   - 可以測試音檔連結
   - 可以下載至少一集音檔
   - 可以完成一集的轉錄並下載逐字稿

