FROM node:18-alpine

WORKDIR /app

# 複製 package.json 和 package-lock.json
COPY package*.json ./

# 安裝所有依賴（包括開發依賴，用於構建）
RUN npm ci

# 複製所有文件
COPY . .

# 構建前端
RUN npm run build

# 清理開發依賴，只保留生產依賴
RUN npm ci --only=production && npm cache clean --force

# 暴露端口（使用環境變數）
EXPOSE $PORT

# 啟動服務器
CMD ["node", "server.js"] 