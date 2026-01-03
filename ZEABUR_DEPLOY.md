# Zeabur 部署指南

## 部署前檢查清單

### 1. 環境變數設置
在 Zeabur 後台設置以下環境變數：
- `OPENAI_API_KEY`: 你的 OpenAI API 金鑰
- `NODE_ENV`: production（通常會自動設置）
- `PORT`: Zeabur 會自動設置，不需要手動設置

### 2. 建置流程
Zeabur 會自動執行：
1. `npm install` - 安裝所有依賴
2. `npm run build` - 建置 React 前端
3. `node server.js` - 啟動伺服器

### 3. 常見問題

#### 問題 1: FFmpeg 不可用
如果遇到 FFmpeg 相關錯誤，這是正常的。應用程式會自動降級處理：
- 小檔案（< 25MB）：直接轉錄
- 大檔案：會提示需要手動壓縮

#### 問題 2: Build 目錄不存在
確保 `npm run build` 成功執行。如果失敗，檢查：
- Node.js 版本是否為 18 或 20
- 是否有足夠的記憶體
- 檢查建置日誌中的錯誤訊息

#### 問題 3: 端口錯誤
Zeabur 會自動設置 PORT 環境變數，不需要在配置中手動設置。

### 4. 檢查部署日誌
在 Zeabur 後台查看：
1. Build Logs - 檢查建置是否成功
2. Runtime Logs - 檢查應用程式是否正常啟動

### 5. 測試部署
部署成功後，訪問你的 Zeabur URL，應該能看到：
- 首頁正常顯示
- RSS 解析功能正常
- 轉錄功能需要設置 OPENAI_API_KEY

## 配置檔案說明

### zeabur.json
Zeabur 的主要配置檔案，定義建置和運行命令。

### zbpack.json
Zeabur 的打包配置，定義 Node.js 版本和建置命令。

### Dockerfile
如果 Zeabur 使用 Docker 部署，會使用此檔案。


