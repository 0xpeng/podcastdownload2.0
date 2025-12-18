FROM node:20-alpine

# 安裝 FFmpeg
RUN apk add --no-cache ffmpeg

# 設置工作目錄
WORKDIR /app

# 複製 package.json 和 package-lock.json
COPY package*.json ./

# 安裝所有依賴（包括 devDependencies，因為 build 需要）
RUN npm ci

# 複製應用程式碼
COPY . .

# 建構前端
RUN npm run build

# 暴露端口
EXPOSE 3000

# 啟動應用
CMD ["npm", "start"]
