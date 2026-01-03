// 載入 .env（若存在），讓本機可以用 .env 管理金鑰
require('dotenv').config();

const express = require('express');
const path = require('path');
const formidable = require('formidable');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const OpenAI = require('openai');
const ffmpeg = require('fluent-ffmpeg'); 

// 導入新的轉錄服務模塊
const {
  TranscriptionFormatter,
  TranscriptionOptimizer,
  SpeakerDiarization,
  TranscriptionProcessor
} = require('./transcription-service');

// 新增：音檔格式驗證和正規化函數
function validateAndNormalizeAudioFile(filePath) {
  const supportedExtensions = ['.flac', '.m4a', '.mp3', '.mp4', '.mpeg', '.mpga', '.oga', '.ogg', '.wav', '.webm'];
  const currentExt = path.extname(filePath).toLowerCase();
  
  console.log(`驗證音檔格式: ${filePath}`);
  console.log(`當前副檔名: ${currentExt}`);
  
  // 檢查是否為支援的格式
  if (!supportedExtensions.includes(currentExt)) {
    throw new Error(`不支援的音檔格式: ${currentExt}。支援格式: ${supportedExtensions.join(', ')}`);
  }
  
  // 正規化檔案副檔名（確保小寫）
  const normalizedPath = filePath.replace(/\.[^.]+$/, currentExt);
  
  // 如果路徑改變了，重新命名檔案
  if (normalizedPath !== filePath && fs.existsSync(filePath)) {
    console.log(`正規化檔案副檔名: ${filePath} -> ${normalizedPath}`);
    fs.renameSync(filePath, normalizedPath);
    return normalizedPath;
  }
  
  return filePath;
}

// 新增：檢查檔案是否為有效的音檔
function validateAudioFileContent(filePath) {
  try {
    const stats = fs.statSync(filePath);
    console.log(`檔案大小: ${(stats.size / 1024 / 1024).toFixed(2)}MB`);
    
    // 檢查檔案大小
    if (stats.size === 0) {
      throw new Error('音檔檔案為空');
    }
    
    if (stats.size < 1000) { // 小於 1KB 可能不是有效音檔
      throw new Error('音檔檔案太小，可能已損壞');
    }
    
    // 讀取檔案前幾個位元組檢查檔案簽名
    const buffer = Buffer.alloc(12);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, 12, 0);
    fs.closeSync(fd);
    
    // 檢查常見音檔格式的檔案簽名
    const hex = buffer.toString('hex').toUpperCase();
    console.log(`檔案簽名: ${hex}`);
    
    // MP3 檔案簽名檢查
    if (hex.startsWith('494433') || // ID3v2
        hex.startsWith('FFFB') ||   // MP3 frame header
        hex.startsWith('FFF3') ||   // MP3 frame header
        hex.startsWith('FFF2')) {   // MP3 frame header
      console.log('✅ 檔案簽名確認為 MP3 格式');
      return true;
    }
    
    // WAV 檔案簽名
    if (hex.startsWith('52494646') && hex.includes('57415645')) {
      console.log('✅ 檔案簽名確認為 WAV 格式');
      return true;
    }
    
    // M4A/MP4 檔案簽名
    if (hex.includes('66747970')) {
      console.log('✅ 檔案簽名確認為 M4A/MP4 格式');
      return true;
    }
    
    // OGG 檔案簽名
    if (hex.startsWith('4F676753')) {
      console.log('✅ 檔案簽名確認為 OGG 格式');
      return true;
    }
    
    // FLAC 檔案簽名
    if (hex.startsWith('664C6143')) {
      console.log('✅ 檔案簽名確認為 FLAC 格式');
      return true;
    }
    
    console.log('⚠️ 無法識別檔案格式，但將嘗試繼續處理');
    return true;
    
  } catch (error) {
    console.error('檔案驗證失敗:', error);
    throw new Error(`音檔檔案驗證失敗: ${error.message}`);
  }
}

let ffmpegAvailable = true;

// 新增：轉錄日誌儲存系統（記憶體儲存，每個 episodeId 對應一個日誌陣列）
const transcriptionLogs = new Map();

// 新增：日誌記錄函數
function addTranscriptionLog(episodeId, level, message, stage) {
  if (!transcriptionLogs.has(episodeId)) {
    transcriptionLogs.set(episodeId, []);
  }
  const logs = transcriptionLogs.get(episodeId);
  const memory = logMemoryUsage('', true); // 獲取記憶體資訊但不輸出
  logs.push({
    timestamp: new Date().toISOString(),
    level,
    message,
    stage,
    memory
  });
  // 限制日誌數量，避免記憶體過大（保留最近 500 條）
  if (logs.length > 500) {
    logs.shift();
  }
}

// 新增：清理舊日誌（完成後保留 5 分鐘）
function cleanupLogs(episodeId) {
  setTimeout(() => {
    transcriptionLogs.delete(episodeId);
    console.log(`已清理 ${episodeId} 的日誌`);
  }, 5 * 60 * 1000); // 5 分鐘後清理
}

// 增加 Node.js 記憶體限制提示
const memoryLimit = process.env.NODE_OPTIONS?.includes('--max-old-space-size') 
  ? '已設置' 
  : '預設（建議使用 --max-old-space-size=4096）';
console.log(`📊 Node.js 記憶體配置: ${memoryLimit}`);

const app = express();
const PORT = process.env.PORT || 3000;

// 增加請求體大小限制（用於大檔案上傳）
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// 設置 Express server timeout（60 分鐘，用於處理超長音檔）
app.timeout = 30 * 60 * 1000; // 30 分鐘
console.log(`✅ Express server timeout 設置為: ${app.timeout / 1000 / 60} 分鐘`);

// 初始化 OpenAI 客戶端，強制使用官方端點避免代理問題
let openai = null;
if (process.env.OPENAI_API_KEY) {
  try {
    // 強制使用官方 OpenAI API 端點，避免代理認證問題
    const baseURL = 'https://api.openai.com/v1';
    
    openai = new OpenAI({ 
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: baseURL,
      timeout: 20 * 60 * 1000, // 20 分鐘超時（足夠處理長音檔轉錄）
      maxRetries: 2   // 最多重試 2 次
    });
    
    console.log(`🔧 OpenAI 客戶端初始化成功，使用官方端點: ${baseURL}`);
    console.log(`🔑 API Key 前綴: ${process.env.OPENAI_API_KEY ? process.env.OPENAI_API_KEY.substring(0, 7) + '...' : '未設置'}`);
    console.log(`📏 API Key 長度: ${process.env.OPENAI_API_KEY ? process.env.OPENAI_API_KEY.length : 0}`);
    console.log(`✅ API Key 格式檢查: ${process.env.OPENAI_API_KEY ? (process.env.OPENAI_API_KEY.startsWith('sk-proj-') ? '✅ 正確' : '❌ 格式錯誤') : '❌ 未設置'}`);
    console.log(`🚀 準備就緒，避免了所有代理認證問題！`);
  } catch (error) {
    console.warn('OpenAI 初始化失敗:', error);
    openai = new OpenAI({ 
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 20 * 60 * 1000, // 20 分鐘超時
      maxRetries: 2
    });
  }
} else {
  console.warn('Warning: OPENAI_API_KEY is not set. Transcription API will be disabled.');
}

// 設置 body parser
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

// 測試 API
app.all('/api/test', (req, res) => {
  console.log(`測試 API: ${req.method} ${req.url}`);
  
  res.json({
    success: true,
    message: 'API 測試成功！',
    timestamp: new Date().toISOString(),
    environment: {
      nodeVersion: process.version,
      env: {
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ? '已設置' : '未設置',
        PORT: process.env.PORT || '未設置'
      }
    },
    openai: {
      initialized: openai !== null,
      baseURL: openai ? openai.baseURL : '未初始化'
    },
    features: {
      enhancedTranscription: true,
      multipleFormats: true,
      speakerDiarization: 'experimental',
      audioProcessing: ffmpegAvailable
    }
  });
});

// 下載 API
app.post('/api/download', (req, res) => {
  console.log(`=== 音檔下載代理請求開始 ===`);
  
  const { audioUrl, title } = req.body;
  
  if (!audioUrl) {
    return res.status(400).json({ error: '缺少音檔 URL' });
  }

  console.log(`開始下載音檔: ${title || 'Unknown'}`);
  console.log(`音檔 URL: ${audioUrl}`);

  // 下載音檔
  downloadAudio(audioUrl, (error, audioBuffer) => {
    if (error) {
      console.error('音檔下載錯誤:', error);
      if (!res.headersSent) {
        return res.status(500).json({ 
          error: `音檔下載失敗: ${error.message}` 
        });
      }
      return;
    }

    console.log(`音檔下載完成，大小: ${(audioBuffer.length / 1024 / 1024).toFixed(2)}MB`);

    // 檢查下載的內容是否為有效音檔
    if (audioBuffer.length < 1024) {
      if (!res.headersSent) {
        return res.status(500).json({ 
          error: '下載的檔案太小，可能不是有效的音檔' 
        });
      }
      return;
    }

    if (!res.headersSent) {
      // 設置響應 headers
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', audioBuffer.length);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(title || 'audio')}.mp3"`);
      
      // 返回音檔數據
      res.send(audioBuffer);
    }
  });
});

// 輔助函數：記錄記憶體使用
function logMemoryUsage(stage, silent = false) {
  const usage = process.memoryUsage();
  const formatMB = (bytes) => (bytes / 1024 / 1024).toFixed(2);
  const memoryInfo = `RSS=${formatMB(usage.rss)}MB, Heap=${formatMB(usage.heapUsed)}/${formatMB(usage.heapTotal)}MB, External=${formatMB(usage.external)}MB`;
  if (!silent) {
    console.log(`[記憶體] ${stage}: ${memoryInfo}`);
  }
  return memoryInfo;
}

// 新增：檢測 API 額度/用量錯誤的輔助函數
function detectQuotaError(error) {
  const result = {
    isQuotaError: false,
    errorType: null,
    userMessage: '',
    shouldRetry: true
  };

  // 檢查 HTTP 響應狀態碼
  if (error.response) {
    const status = error.response.status;
    const errorData = error.response.data || {};

    if (status === 429) {
      result.isQuotaError = true;
      result.errorType = 'rate_limit';
      result.userMessage = 'API 請求頻率過高（Rate Limit），請稍後再試或檢查用量限制';
      result.shouldRetry = true; // Rate Limit 可以重試
    } else if (status === 402) {
      result.isQuotaError = true;
      result.errorType = 'payment_required';
      result.userMessage = 'API 餘額不足或付款方式有問題，請檢查 OpenAI 帳戶餘額和付款方式';
      result.shouldRetry = false; // 餘額問題不應該重試
    } else if (status === 401) {
      result.isQuotaError = true;
      result.errorType = 'authentication';
      result.userMessage = 'API 金鑰無效或已過期，請檢查 OPENAI_API_KEY 設定';
      result.shouldRetry = false; // 認證問題不應該重試
    } else if (status === 403) {
      result.isQuotaError = true;
      result.errorType = 'forbidden';
      result.userMessage = 'API 存取被拒絕，可能是額度用盡或權限問題，請檢查 OpenAI 帳戶';
      result.shouldRetry = false;
    }
  } else if (error.cause) {
    // 檢查連接錯誤（可能是額度問題導致的連接重置）
    const errno = error.cause.errno;
    const errorMessage = error.message || '';

    // ECONNRESET 可能是額度問題，但也可能是網路問題
    if (errno === 'ECONNRESET' && errorMessage.includes('Connection error')) {
      result.isQuotaError = true; // 標記為可能的額度問題
      result.errorType = 'connection_reset';
      result.userMessage = '連接被重置，可能是 API 額度用盡或網路問題。請檢查 OpenAI 帳戶的 API 餘額和用量限制';
      result.shouldRetry = true; // 連接錯誤可以重試
    }
  }

  return result;
}

// 新增：查詢轉錄日誌 API
app.get('/api/transcribe-logs/:episodeId', (req, res) => {
  const { episodeId } = req.params;
  const logs = transcriptionLogs.get(episodeId) || [];
  res.json({
    success: true,
    episodeId,
    logs,
    count: logs.length
  });
});

// 新增：直接從 URL 轉錄 API（支援大檔案，不經過前端上傳）
app.post('/api/transcribe-from-url', async (req, res) => {
  const requestStartTime = Date.now();
  console.log(`\n=== 直接從 URL 轉錄 API 請求開始 ===`);
  console.log(`請求時間: ${new Date().toISOString()}`);
  logMemoryUsage('請求開始');
  
  // 設置更長的 timeout（60 分鐘）
  req.setTimeout(60 * 60 * 1000);
  res.setTimeout(60 * 60 * 1000);
  
  const { 
    audioUrl, 
    title, 
    episodeId,
    outputFormats = ['txt'],
    contentType = 'podcast',
    enableSpeakerDiarization = false,
    keywords = '',
    sourceLanguage = 'auto'
  } = req.body;
  
  if (!audioUrl) {
    return res.status(400).json({ error: '缺少音檔 URL' });
  }
  
  // 初始化日誌
  const finalEpisodeId = episodeId || `url_${Date.now()}`;
  transcriptionLogs.set(finalEpisodeId, []);
  addTranscriptionLog(finalEpisodeId, 'info', '轉錄任務開始（直接從 URL）', '初始化');
  addTranscriptionLog(finalEpisodeId, 'info', `音檔 URL: ${audioUrl}`, '初始化');
  addTranscriptionLog(finalEpisodeId, 'info', `標題: ${title || 'Unknown'}`, '初始化');
  
  // 創建臨時目錄
  const tempDir = path.join(__dirname, 'temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  
  const tempAudioPath = path.join(tempDir, `audio_${Date.now()}_${Math.random().toString(36).substring(7)}.mp3`);
  
  try {
    // 1. 下載音檔到臨時檔案
    console.log('步驟 1: 開始下載音檔...');
    addTranscriptionLog(finalEpisodeId, 'info', '開始下載音檔...', '下載');
    const downloadStartTime = Date.now();
    
    await new Promise((resolve, reject) => {
      downloadAudio(audioUrl, async (error, audioBuffer) => {
        if (error) {
          console.error('音檔下載錯誤:', error);
          addTranscriptionLog(finalEpisodeId, 'error', `音檔下載失敗: ${error.message}`, '錯誤');
          reject(error);
          return;
        }
        
        const fileSizeMB = (audioBuffer.length / 1024 / 1024).toFixed(2);
        const downloadDuration = ((Date.now() - downloadStartTime) / 1000).toFixed(2);
        console.log(`音檔下載完成，大小: ${fileSizeMB}MB，耗時: ${downloadDuration} 秒`);
        addTranscriptionLog(finalEpisodeId, 'success', `音檔下載完成，大小: ${fileSizeMB}MB，耗時: ${downloadDuration} 秒`, '下載');
        
        // 檢查下載的內容是否為有效音檔
        if (audioBuffer.length < 1024) {
          reject(new Error('下載的檔案太小，可能不是有效的音檔'));
          return;
        }
        
        // 寫入臨時檔案
        try {
          fs.writeFileSync(tempAudioPath, audioBuffer);
          console.log(`音檔已保存到臨時檔案: ${tempAudioPath}`);
          resolve(tempAudioPath);
        } catch (writeError) {
          reject(new Error(`寫入臨時檔案失敗: ${writeError.message}`));
        }
      });
    });
    
    // 2. 創建檔案物件（模擬 formidable 的檔案物件）
    const audioFile = {
      filepath: tempAudioPath,
      size: fs.statSync(tempAudioPath).size,
      originalFilename: `${title || 'audio'}.mp3`,
      mimetype: 'audio/mpeg'
    };
    
    const fileSizeMB = (audioFile.size / 1024 / 1024).toFixed(2);
    const estimatedDuration = Math.ceil((audioFile.size / 1024 / 1024) * 0.5);
    console.log(`\n📋 轉錄任務資訊:`);
    console.log(`  標題: ${title || 'Unknown'}`);
    console.log(`  檔案大小: ${fileSizeMB}MB`);
    console.log(`  預估時長: 約 ${estimatedDuration} 分鐘`);
    console.log(`  輸出格式: ${outputFormats.join(', ')}`);
    console.log(`  內容類型: ${contentType}`);
    console.log(`  說話者分離: ${enableSpeakerDiarization ? '啟用' : '停用'}`);
    logMemoryUsage('任務開始');
    
    addTranscriptionLog(finalEpisodeId, 'info', `檔案大小: ${fileSizeMB}MB，預估時長: 約 ${estimatedDuration} 分鐘`, '任務資訊');
    addTranscriptionLog(finalEpisodeId, 'info', `輸出格式: ${outputFormats.join(', ')}, 內容類型: ${contentType}`, '任務資訊');
    
    // 3. 驗證和正規化音檔格式
    try {
      console.log('=== 音檔格式驗證開始 ===');
      const normalizedFilePath = validateAndNormalizeAudioFile(audioFile.filepath);
      audioFile.filepath = normalizedFilePath;
      validateAudioFileContent(audioFile.filepath);
      console.log(`✅ 音檔格式驗證通過: ${audioFile.filepath}`);
    } catch (validationError) {
      console.error('=== 音檔格式驗證失敗 ===');
      console.error('驗證錯誤:', validationError);
      
      try {
        fs.unlinkSync(tempAudioPath);
      } catch (cleanupError) {
        console.warn('清理無效檔案失敗:', cleanupError);
      }
      
      return res.status(400).json({
        error: `音檔格式驗證失敗: ${validationError.message}`,
        suggestions: [
          '請確保檔案是有效的音檔格式',
          '支援格式: MP3, WAV, M4A, FLAC, OGG, WebM',
          '檢查檔案是否完整下載',
          '嘗試使用其他音檔轉換工具重新編碼'
        ]
      });
    }
    
    // 4. 處理大檔案（壓縮/分割）
    const OPENAI_LIMIT = 25 * 1024 * 1024;
    let processedAudio;
    
    if (audioFile.size > OPENAI_LIMIT) {
      const fileSizeMB = (audioFile.size / 1024 / 1024).toFixed(2);
      console.log(`\n🔧 [階段 1/4] 音檔處理開始`);
      console.log(`  音檔大小 ${fileSizeMB}MB 超過 25MB，啟動自動處理...`);
      const processingStartTime = Date.now();
      logMemoryUsage('音檔處理開始');
      addTranscriptionLog(finalEpisodeId, 'info', `[階段 1/4] 音檔處理開始 - 檔案大小 ${fileSizeMB}MB 超過 25MB，啟動自動處理`, '音檔處理');
      
      try {
        processedAudio = await processLargeAudio(audioFile, title || 'Unknown');
        const processingDuration = ((Date.now() - processingStartTime) / 1000).toFixed(2);
        console.log(`✅ [階段 1/4] 音檔處理完成，耗時: ${processingDuration} 秒`);
        logMemoryUsage('音檔處理完成');
        addTranscriptionLog(finalEpisodeId, 'success', `[階段 1/4] 音檔處理完成，耗時: ${processingDuration} 秒`, '音檔處理');
        if (processedAudio.type === 'segments') {
          addTranscriptionLog(finalEpisodeId, 'info', `音檔已分割為 ${processedAudio.totalSegments} 個片段`, '音檔處理');
        }
      } catch (ffmpegError) {
        if (ffmpegError.message.includes("ffmpeg") || ffmpegError.message.includes("ENOENT")) {
          console.error("FFmpeg 不可用:", ffmpegError.message);
          return res.status(413).json({
            error: "音檔大小超過限制，且伺服器音檔處理功能不可用",
            message: "請手動壓縮音檔",
            suggestions: [
              "使用音訊編輯軟體壓縮至25MB以下",
              "降低音質至128kbps或更低",
              "分割成較短片段",
              "轉換為MP3格式"
            ],
            currentSize: fileSizeMB + "MB",
            maxSize: "25MB"
          });
        }
        throw ffmpegError;
      }
    } else {
      processedAudio = {
        type: 'single',
        file: audioFile.filepath,
        size: audioFile.size
      };
    }
    
    // 5. 檢查 OpenAI API 金鑰
    if (!process.env.OPENAI_API_KEY) {
      console.error('OpenAI API 金鑰未設置');
      return res.status(500).json({
        error: 'OpenAI API 金鑰未設置'
      });
    }
    
    // 6. 開始轉錄（重用現有邏輯）
    console.log(`\n🎤 [階段 2/4] 開始轉錄`);
    console.log(`  OpenAI API 端點: ${openai.baseURL}`);
    const transcriptionStartTime = Date.now();
    logMemoryUsage('轉錄開始');
    addTranscriptionLog(finalEpisodeId, 'info', `[階段 2/4] 開始轉錄 - OpenAI API 端點: ${openai.baseURL}`, '轉錄');
    
    let finalTranscription;
    
    // 確定使用的語言（用於生成提示詞）
    // 如果 auto，不傳遞 language 參數，讓 OpenAI 自動檢測
    // 轉錄完成後，根據實際檢測到的語言生成對應語言的字幕
    let promptLanguage = sourceLanguage === 'auto' ? null : sourceLanguage;
    
    // 生成優化的提示詞
    let optimizedPrompt;
    if (promptLanguage) {
      optimizedPrompt = TranscriptionOptimizer.generateOptimizedPrompt(promptLanguage, contentType);
    } else {
      // 自動檢測模式：使用通用提示詞，不指定語言
      // 使用英文作為通用提示詞（因為英文 podcast 較多）
      optimizedPrompt = TranscriptionOptimizer.generateOptimizedPrompt('en', contentType);
      // 或者使用更通用的提示詞
      optimizedPrompt = `This is a podcast transcription. Please transcribe accurately with proper punctuation and formatting. Keep the original language of the audio.`;
    }
    
    // 如果有 keywords，將其合併到 prompt 中
    if (keywords && keywords.trim()) {
      optimizedPrompt = `${keywords.trim()}\n\n${optimizedPrompt}`;
      if (optimizedPrompt.length > 400) {
        const keywordsPart = keywords.trim();
        const remainingLength = 400 - keywordsPart.length - 2;
        if (remainingLength > 0) {
          const basePrompt = promptLanguage 
            ? TranscriptionOptimizer.generateOptimizedPrompt(promptLanguage, contentType)
            : `This is a podcast transcription. Please transcribe accurately with proper punctuation and formatting. Keep the original language of the audio.`;
          optimizedPrompt = `${keywordsPart}\n\n${basePrompt.substring(0, remainingLength)}`;
        } else {
          optimizedPrompt = keywordsPart.substring(0, 400);
        }
        console.log('⚠️ 合併後的 prompt 超過 400 字元，已自動截斷');
      }
      console.log(`使用優化提示詞（含關鍵字）: ${optimizedPrompt.substring(0, 100)}...`);
    } else {
      console.log(`使用優化提示詞: ${optimizedPrompt}`);
    }
    
    // 記錄語言設置
    console.log(`語言設置: ${sourceLanguage === 'auto' ? '自動檢測（將根據實際內容生成對應語言字幕）' : sourceLanguage}`);
    addTranscriptionLog(finalEpisodeId, 'info', `語言設置: ${sourceLanguage === 'auto' ? '自動檢測（將根據實際內容生成對應語言字幕）' : sourceLanguage}`, '初始化');
    
    if (processedAudio.type === 'single') {
      // 單一檔案轉錄（帶重試機制）
      console.log('  轉錄模式: 單一檔案');
      const segmentStartTime = Date.now();
      addTranscriptionLog(finalEpisodeId, 'info', '轉錄模式: 單一檔案', '轉錄');
      
      let transcription;
      let retryCount = 0;
      const maxRetries = 5; // 增加重試次數
      
      while (retryCount < maxRetries) {
        try {
          console.log(`  正在呼叫 OpenAI API... (嘗試 ${retryCount + 1}/${maxRetries})`);
          addTranscriptionLog(finalEpisodeId, 'info', `正在呼叫 OpenAI API (whisper-1)... (嘗試 ${retryCount + 1}/${maxRetries})`, '轉錄');
          
          // 每次重試都重新創建文件流
          const transcriptionParams = {
            file: fs.createReadStream(processedAudio.file),
            model: 'whisper-1',
            response_format: 'verbose_json',
            timestamp_granularities: ['word'],
            prompt: optimizedPrompt
          };
          
          if (sourceLanguage && sourceLanguage !== 'auto') {
            transcriptionParams.language = sourceLanguage;
            console.log(`  使用指定語言: ${sourceLanguage}`);
          } else {
            console.log('  使用自動語言檢測');
          }
          
          transcription = await openai.audio.transcriptions.create(transcriptionParams);
          
          const segmentDuration = ((Date.now() - segmentStartTime) / 1000).toFixed(2);
          console.log(`  ✅ 使用 whisper-1 模型轉錄成功，耗時: ${segmentDuration} 秒`);
          addTranscriptionLog(finalEpisodeId, 'success', `使用 whisper-1 模型轉錄成功，耗時: ${segmentDuration} 秒`, '轉錄');
          break; // 成功，跳出重試循環
          
        } catch (modelError) {
          retryCount++;
          
          // 檢測 API 額度錯誤
          const quotaCheck = detectQuotaError(modelError);
          
          // 記錄詳細錯誤信息
          console.error(`  ❌ API 調用錯誤 (嘗試 ${retryCount}/${maxRetries}):`, modelError.message);
          
          if (quotaCheck.isQuotaError) {
            console.error(`  ⚠️ 檢測到 API 額度/用量問題: ${quotaCheck.errorType}`);
            console.error(`  💡 提示: ${quotaCheck.userMessage}`);
            addTranscriptionLog(finalEpisodeId, 'error', `⚠️ ${quotaCheck.userMessage}`, '錯誤');
            addTranscriptionLog(finalEpisodeId, 'info', `💡 請檢查 OpenAI 帳戶: https://platform.openai.com/usage`, '建議');
            
            // 如果是餘額或認證問題，不重試，直接拋出
            if (!quotaCheck.shouldRetry) {
              const enhancedError = new Error(quotaCheck.userMessage);
              enhancedError.isQuotaError = true;
              enhancedError.errorType = quotaCheck.errorType;
              enhancedError.originalError = modelError;
              throw enhancedError;
            }
          } else {
            // 記錄其他錯誤詳情
            if (modelError.response) {
              const status = modelError.response.status;
              const statusText = modelError.response.statusText;
              const errorData = modelError.response.data || {};
              console.error(`  API 響應錯誤: ${status} ${statusText}`, errorData);
              addTranscriptionLog(finalEpisodeId, 'error', `API 錯誤: ${status} ${statusText} - ${errorData.error?.message || modelError.message}`, '轉錄');
            } else if (modelError.cause?.errno) {
              console.error(`  連接錯誤: ${modelError.cause.errno} (${modelError.cause.type})`);
              addTranscriptionLog(finalEpisodeId, 'error', `連接錯誤: ${modelError.cause.errno} - ${modelError.message}`, '轉錄');
            } else {
              addTranscriptionLog(finalEpisodeId, 'error', `API 錯誤: ${modelError.message}`, '轉錄');
            }
          }
          
          if (retryCount >= maxRetries) {
            console.error(`  ❌ 轉錄失敗，已重試 ${maxRetries} 次`);
            addTranscriptionLog(finalEpisodeId, 'error', `轉錄失敗，已重試 ${maxRetries} 次: ${modelError.message}`, '錯誤');
            
            // 如果是最後一次重試且是連接錯誤，給出額度檢查建議
            if (modelError.cause?.errno === 'ECONNRESET') {
              addTranscriptionLog(finalEpisodeId, 'info', `💡 建議：請檢查 OpenAI 帳戶的 API 餘額和用量限制`, '建議');
            }
            
            throw modelError;
          } else {
            // 對於連接錯誤，使用更長的重試延遲
            const baseDelay = (modelError.cause?.errno === 'ECONNRESET' || quotaCheck.isQuotaError) ? 5000 : 2000;
            const retryDelay = Math.min(baseDelay * Math.pow(2, retryCount - 1), 30000);
            console.warn(`  ⚠️ ${retryDelay / 1000} 秒後重試... (${retryCount}/${maxRetries})`);
            addTranscriptionLog(finalEpisodeId, 'warn', `${retryDelay / 1000} 秒後重試... (${retryCount}/${maxRetries})`, '轉錄');
            await new Promise(resolve => setTimeout(resolve, retryDelay));
          }
        }
      }
      
      finalTranscription = transcription;
      
    } else {
      // 多片段轉錄 - 使用並行處理
      console.log(`  轉錄模式: 多片段（共 ${processedAudio.totalSegments} 個片段）`);
      const totalSegments = processedAudio.files.length;
      const CONCURRENT_LIMIT = 3;
      const SEGMENT_DURATION = 300;
      
      console.log(`  🚀 啟用並行處理模式，同時處理 ${CONCURRENT_LIMIT} 個片段`);
      addTranscriptionLog(finalEpisodeId, 'info', `啟用並行處理模式，同時處理 ${CONCURRENT_LIMIT} 個片段`, '轉錄');
      
      // 處理單個片段的函數（帶重試機制）
      async function processSegmentWithRetry(segmentFile, segmentIndex, totalSegments) {
        const segmentStartTime = Date.now();
        console.log(`\n  📝 片段 ${segmentIndex}/${totalSegments}: ${path.basename(segmentFile)}`);
        logMemoryUsage(`片段 ${segmentIndex} 開始`);
        addTranscriptionLog(finalEpisodeId, 'info', `片段 ${segmentIndex}/${totalSegments}: ${path.basename(segmentFile)}`, '轉錄');
        
        let transcription;
        let retryCount = 0;
        const maxRetries = 3;
        
        while (retryCount < maxRetries) {
          try {
            console.log(`    正在呼叫 OpenAI API... (嘗試 ${retryCount + 1}/${maxRetries})`);
            addTranscriptionLog(finalEpisodeId, 'info', `片段 ${segmentIndex} 正在呼叫 OpenAI API... (嘗試 ${retryCount + 1}/${maxRetries})`, '轉錄');
            
            const transcriptionParams = {
              file: fs.createReadStream(segmentFile),
              model: 'whisper-1',
              response_format: 'verbose_json',
              timestamp_granularities: ['word'],
              prompt: optimizedPrompt
            };
            
            if (sourceLanguage && sourceLanguage !== 'auto') {
              transcriptionParams.language = sourceLanguage;
            }
            
            transcription = await openai.audio.transcriptions.create(transcriptionParams);
            break;
          } catch (modelError) {
            retryCount++;
            
            // 檢測 API 額度錯誤
            const quotaCheck = detectQuotaError(modelError);
            
            // 記錄詳細錯誤信息
            console.error(`    ❌ API 調用錯誤 (嘗試 ${retryCount}/${maxRetries}):`, modelError.message);
            
            if (quotaCheck.isQuotaError) {
              console.error(`    ⚠️ 檢測到 API 額度/用量問題: ${quotaCheck.errorType}`);
              console.error(`    💡 提示: ${quotaCheck.userMessage}`);
              addTranscriptionLog(finalEpisodeId, 'error', `⚠️ ${quotaCheck.userMessage}`, '錯誤');
              addTranscriptionLog(finalEpisodeId, 'info', `💡 請檢查 OpenAI 帳戶: https://platform.openai.com/usage`, '建議');
              
              // 如果是餘額或認證問題，不重試，直接拋出
              if (!quotaCheck.shouldRetry) {
                const enhancedError = new Error(quotaCheck.userMessage);
                enhancedError.isQuotaError = true;
                enhancedError.errorType = quotaCheck.errorType;
                enhancedError.originalError = modelError;
                throw enhancedError;
              }
            } else {
              // 記錄其他錯誤詳情
              if (modelError.response) {
                const status = modelError.response.status;
                const statusText = modelError.response.statusText;
                const errorData = modelError.response.data || {};
                console.error(`    API 響應錯誤: ${status} ${statusText}`, errorData);
                addTranscriptionLog(finalEpisodeId, 'error', `API 錯誤: ${status} ${statusText} - ${errorData.error?.message || modelError.message}`, '轉錄');
              } else if (modelError.cause?.errno) {
                console.error(`    連接錯誤: ${modelError.cause.errno} (${modelError.cause.type})`);
                addTranscriptionLog(finalEpisodeId, 'error', `連接錯誤: ${modelError.cause.errno} - ${modelError.message}`, '轉錄');
              } else if (modelError.code) {
                console.error(`    錯誤代碼: ${modelError.code}`);
                addTranscriptionLog(finalEpisodeId, 'error', `API 錯誤: ${modelError.code} - ${modelError.message}`, '轉錄');
              } else {
                addTranscriptionLog(finalEpisodeId, 'error', `API 錯誤: ${modelError.message}`, '轉錄');
              }
            }
            
            if (retryCount >= maxRetries) {
              console.error(`    ❌ 轉錄失敗，已重試 ${maxRetries} 次`);
              addTranscriptionLog(finalEpisodeId, 'error', `轉錄失敗，已重試 ${maxRetries} 次: ${modelError.message}`, '錯誤');
              
              // 如果是最後一次重試且是連接錯誤，給出額度檢查建議
              if (modelError.cause?.errno === 'ECONNRESET') {
                addTranscriptionLog(finalEpisodeId, 'info', `💡 建議：請檢查 OpenAI 帳戶的 API 餘額和用量限制`, '建議');
              }
              
              throw modelError;
            } else {
              // 對於連接錯誤或額度問題，使用更長的重試延遲
              const baseDelay = (modelError.cause?.errno === 'ECONNRESET' || quotaCheck.isQuotaError) ? 5000 : 2000;
              const retryDelay = Math.min(baseDelay * Math.pow(2, retryCount - 1), 30000);
              console.warn(`    ⚠️ ${retryDelay / 1000} 秒後重試... (${retryCount}/${maxRetries})`);
              addTranscriptionLog(finalEpisodeId, 'warn', `${retryDelay / 1000} 秒後重試... (${retryCount}/${maxRetries})`, '轉錄');
              await new Promise(resolve => setTimeout(resolve, retryDelay));
            }
          }
        }
        
        const segmentDuration = ((Date.now() - segmentStartTime) / 1000).toFixed(2);
        console.log(`    ✅ 片段 ${segmentIndex} 轉錄完成，耗時: ${segmentDuration} 秒`);
        logMemoryUsage(`片段 ${segmentIndex} 完成`);
        addTranscriptionLog(finalEpisodeId, 'success', `片段 ${segmentIndex} 轉錄完成，耗時: ${segmentDuration} 秒`, '轉錄');
        
        return { index: segmentIndex - 1, transcription };
      }
      
      // 並行處理所有片段
      const results = [];
      const activePromises = new Set();
      
      async function processWithConcurrencyLimit(segmentFile, segmentIndex, totalSegments) {
        while (activePromises.size >= CONCURRENT_LIMIT) {
          await Promise.race(Array.from(activePromises));
        }
        
        const promise = processSegmentWithRetry(segmentFile, segmentIndex, totalSegments)
          .then(result => {
            results.push(result);
            activePromises.delete(promise);
            return result;
          })
          .catch(error => {
            console.error(`片段 ${segmentIndex} 處理失敗:`, error);
            addTranscriptionLog(finalEpisodeId, 'error', `片段 ${segmentIndex} 處理失敗: ${error.message}`, '錯誤');
            activePromises.delete(promise);
            return { index: segmentIndex - 1, error: error.message };
          });
        
        activePromises.add(promise);
        return promise;
      }
      
      // 啟動所有片段的處理
      const allPromises = [];
      for (let i = 0; i < processedAudio.files.length; i++) {
        allPromises.push(processWithConcurrencyLimit(processedAudio.files[i], i + 1, totalSegments));
      }
      
      // 等待所有片段完成
      await Promise.all(allPromises);
      
      // 按順序合併結果
      results.sort((a, b) => a.index - b.index);
      
      let mergedResult = {
        text: '',
        duration: 0,
        segments: [],
        totalSegments: 0
      };
      
      let cumulativeOffset = 0;
      
      for (const result of results) {
        if (result.error) {
          console.error(`⚠️ 片段 ${result.index + 1} 處理失敗，跳過: ${result.error}`);
          cumulativeOffset += SEGMENT_DURATION;
          continue;
        }
        
        const segmentOffset = result.index * SEGMENT_DURATION;
        
        mergedResult = mergeTranscriptionIncrementalWithOffset(
          mergedResult,
          result.transcription,
          result.index + 1,
          totalSegments,
          segmentOffset,
          SEGMENT_DURATION
        );
        
        cumulativeOffset += SEGMENT_DURATION;
      }
      
      mergedResult.duration = cumulativeOffset;
      finalTranscription = mergedResult;
      console.log(`\n  ✅ 所有片段轉錄並合併完成，共 ${totalSegments} 個片段`);
      addTranscriptionLog(finalEpisodeId, 'success', `所有片段轉錄並合併完成，共 ${totalSegments} 個片段`, '轉錄');
    }
    
    const transcriptionDuration = ((Date.now() - transcriptionStartTime) / 1000 / 60).toFixed(2);
    console.log(`✅ [階段 2/4] 轉錄完成，總耗時: ${transcriptionDuration} 分鐘`);
    logMemoryUsage('轉錄完成');
    addTranscriptionLog(finalEpisodeId, 'success', `[階段 2/4] 轉錄完成，總耗時: ${transcriptionDuration} 分鐘`, '轉錄');
    
    // 檢測轉錄結果的實際語言
    let detectedLanguage = 'en'; // 默認
    if (finalTranscription.language) {
      detectedLanguage = finalTranscription.language;
      console.log(`✅ 從轉錄結果檢測到語言: ${detectedLanguage}`);
      addTranscriptionLog(finalEpisodeId, 'info', `從轉錄結果檢測到語言: ${detectedLanguage}`, '轉錄');
    } else if (sourceLanguage !== 'auto') {
      detectedLanguage = sourceLanguage;
      console.log(`✅ 使用指定的語言: ${detectedLanguage}`);
      addTranscriptionLog(finalEpisodeId, 'info', `使用指定的語言: ${detectedLanguage}`, '轉錄');
    } else {
      // 簡單的語言檢測：檢查文字內容
      const text = finalTranscription.text || '';
      // 如果主要是英文字符，判斷為英文
      const englishCharCount = (text.match(/[a-zA-Z]/g) || []).length;
      const chineseCharCount = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
      const totalCharCount = text.length;
      
      // 計算比例
      const englishRatio = totalCharCount > 0 ? englishCharCount / totalCharCount : 0;
      const chineseRatio = totalCharCount > 0 ? chineseCharCount / totalCharCount : 0;
      
      if (englishRatio > 0.5 || (englishCharCount > chineseCharCount * 2 && englishCharCount > 100)) {
        detectedLanguage = 'en';
      } else if (chineseRatio > 0.3 || chineseCharCount > 50) {
        detectedLanguage = 'zh';
      } else {
        // 默認使用英文
        detectedLanguage = 'en';
      }
      
      console.log(`✅ 通過文字分析檢測到語言: ${detectedLanguage} (英文字符: ${englishCharCount}, 中文字符: ${chineseCharCount})`);
      addTranscriptionLog(finalEpisodeId, 'info', `通過文字分析檢測到語言: ${detectedLanguage} (英文字符: ${englishCharCount}, 中文字符: ${chineseCharCount})`, '轉錄');
    }
    
    // 將檢測到的語言保存到轉錄結果中
    if (!finalTranscription.language) {
      finalTranscription.language = detectedLanguage;
    }
    
    // 7. 錯字檢查與修正（使用檢測到的語言）
    console.log(`\n🔍 [階段 3/4] 開始錯字檢查與修正`);
    const spellCheckStartTime = Date.now();
    logMemoryUsage('錯字檢查開始');
    addTranscriptionLog(finalEpisodeId, 'info', `[階段 3/4] 開始錯字檢查與修正（語言: ${detectedLanguage}）`, '錯字檢查');
    let correctedTranscription = finalTranscription;
    try {
      // 使用檢測到的語言進行錯字檢查
      correctedTranscription = await checkAndCorrectSpelling(finalTranscription, detectedLanguage, contentType);
      const spellCheckDuration = ((Date.now() - spellCheckStartTime) / 1000).toFixed(2);
      console.log(`✅ [階段 3/4] 錯字檢查完成，耗時: ${spellCheckDuration} 秒`);
      logMemoryUsage('錯字檢查完成');
      addTranscriptionLog(finalEpisodeId, 'success', `[階段 3/4] 錯字檢查完成，耗時: ${spellCheckDuration} 秒`, '錯字檢查');
    } catch (spellCheckError) {
      console.warn(`⚠️ [階段 3/4] 錯字檢查失敗，使用原始轉錄結果: ${spellCheckError.message}`);
      logMemoryUsage('錯字檢查失敗');
      addTranscriptionLog(finalEpisodeId, 'warn', `[階段 3/4] 錯字檢查失敗，使用原始轉錄結果: ${spellCheckError.message}`, '錯字檢查');
    }
    
    // 8. 處理說話者分離
    if (enableSpeakerDiarization && correctedTranscription.segments) {
      console.log('開始處理說話者分離...');
      correctedTranscription.segments = await SpeakerDiarization.simulateSpeakerDetection(correctedTranscription.segments);
    }
    
    // 9. 生成多種輸出格式
    console.log(`\n📄 [階段 4/4] 生成多種輸出格式`);
    const formatStartTime = Date.now();
    logMemoryUsage('格式生成開始');
    const processedResult = TranscriptionProcessor.processTranscriptionResult(correctedTranscription, {
      enableSpeakerDiarization,
      outputFormats,
      optimizeSegments: true,
      contentType
    });
    
    // 10. 清理臨時檔案
    try {
      fs.unlinkSync(tempAudioPath);
      
      if (processedAudio.type === 'single' && processedAudio.file !== tempAudioPath) {
        fs.unlinkSync(processedAudio.file);
      } else if (processedAudio.type === 'segments') {
        processedAudio.files.forEach(file => {
          try { fs.unlinkSync(file); } catch (e) {}
        });
        const segmentDir = path.dirname(processedAudio.files[0]);
        try { fs.rmdirSync(segmentDir); } catch (e) {}
        
        const compressedFile = processedAudio.file;
        if (compressedFile && fs.existsSync(compressedFile)) {
          fs.unlinkSync(compressedFile);
        }
      }
      
      console.log('臨時檔案清理成功');
    } catch (cleanupError) {
      console.warn('清理臨時檔案失敗:', cleanupError);
    }
    
    const formatDuration = ((Date.now() - formatStartTime) / 1000).toFixed(2);
    console.log(`✅ [階段 4/4] 格式生成完成，耗時: ${formatDuration} 秒`);
    logMemoryUsage('格式生成完成');
    
    const totalDuration = ((Date.now() - requestStartTime) / 1000 / 60).toFixed(2);
    console.log(`\n🎉 轉錄任務完成: ${title || 'Unknown'}`);
    console.log(`  總耗時: ${totalDuration} 分鐘`);
    console.log(`  文字長度: ${processedResult.formats.txt?.length || 0} 字元`);
    if (processedAudio.type === 'segments') {
      console.log(`  處理片段數: ${processedAudio.totalSegments} 個`);
    }
    logMemoryUsage('任務完成');
    console.log(`=== 直接從 URL 轉錄 API 請求結束 ===\n`);
    
    addTranscriptionLog(finalEpisodeId, 'success', `🎉 轉錄任務完成！總耗時: ${totalDuration} 分鐘，文字長度: ${processedResult.formats.txt?.length || 0} 字元`, '完成');
    
    // 清理日誌（5 分鐘後）
    cleanupLogs(finalEpisodeId);
    
    // 回傳結果
    res.json({
      success: true,
      episodeId: finalEpisodeId,
      title: title || 'Unknown',
      text: processedResult.formats.txt || '',
      formats: processedResult.formats,
      metadata: processedResult.metadata,
      segments: correctedTranscription.segments || [],
      url: `/api/transcribe/${finalEpisodeId}`
    });
    
  } catch (error) {
    console.error('轉錄錯誤:', error);
    addTranscriptionLog(finalEpisodeId, 'error', `轉錄失敗: ${error.message}`, '錯誤');
    
    // 清理臨時檔案
    try {
      if (fs.existsSync(tempAudioPath)) {
        fs.unlinkSync(tempAudioPath);
      }
    } catch (cleanupError) {
      console.warn('清理臨時檔案失敗:', cleanupError);
    }
    
    if (!res.headersSent) {
      return res.status(500).json({
        error: `轉錄失敗: ${error.message}`,
        suggestions: [
          '請檢查音檔 URL 是否有效',
          '確認音檔格式是否支援',
          '檢查網路連線是否穩定'
        ]
      });
    }
  }
});

// 增強版轉錄 API
app.post('/api/transcribe', (req, res) => {
  const requestStartTime = Date.now();
  console.log(`\n=== 增強版轉錄 API 請求開始 ===`);
  console.log(`請求時間: ${new Date().toISOString()}`);
  logMemoryUsage('請求開始');
  
  // 設置更長的 timeout（60 分鐘，用於處理超長音檔）
  req.setTimeout(60 * 60 * 1000); // 60 分鐘
  res.setTimeout(60 * 60 * 1000); // 60 分鐘
  
  // 初始化日誌
  const episodeId = req.body?.episodeId || 'unknown';
  transcriptionLogs.set(episodeId, []);
  addTranscriptionLog(episodeId, 'info', '轉錄任務開始', '初始化');
  
  // 設置 response timeout（30 分鐘）
  req.setTimeout(30 * 60 * 1000, () => {
    console.error('⚠️ 請求超時（30 分鐘）');
    if (!res.headersSent) {
      res.status(504).json({ error: '請求超時，請嘗試分割音檔或使用較短的音檔' });
    }
  });
  
  const form = new formidable.IncomingForm({
    maxFileSize: 32 * 1024 * 1024, // 32MB 上傳上限（增加緩衝空間，避免邊界情況）
    maxTotalFileSize: 32 * 1024 * 1024, // 總檔案大小限制（避免邊界錯誤）
    keepExtensions: true,
    // 增強檔案名稱處理
    filename: (name, ext, part, form) => {
      // 確保檔案有適當的副檔名
      if (!ext || ext === '') {
        // 根據 MIME 類型推斷副檔名
        const mimeType = part.mimetype || '';
        if (mimeType.includes('mp3') || mimeType.includes('mpeg')) {
          ext = '.mp3';
        } else if (mimeType.includes('wav')) {
          ext = '.wav';
        } else if (mimeType.includes('m4a') || mimeType.includes('mp4')) {
          ext = '.m4a';
        } else if (mimeType.includes('ogg')) {
          ext = '.ogg';
        } else if (mimeType.includes('flac')) {
          ext = '.flac';
        } else {
          ext = '.mp3'; // 預設為 mp3
        }
      }
      // 確保副檔名為小寫
      ext = ext.toLowerCase();
      return `audio_${Date.now()}${ext}`;
    }
  });
  
  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error('表單解析錯誤:', err);
      console.error('錯誤詳情:', {
        message: err.message,
        code: err.code,
        httpCode: err.httpCode,
        stack: err.stack
      });
      
      // 處理檔案大小超過限制的錯誤
      if (err.code === 1009 || err.httpCode === 413 || err.message.includes('maxTotalFileSize') || err.message.includes('maxFileSize')) {
        const fileSizeMatch = err.message.match(/(\d+) bytes/);
        const receivedSize = fileSizeMatch ? `${(parseInt(fileSizeMatch[1]) / 1024 / 1024).toFixed(2)}MB` : '未知';
        const maxSizeMatch = err.message.match(/\((\d+) bytes\)/);
        const maxSize = maxSizeMatch ? `${(parseInt(maxSizeMatch[1]) / 1024 / 1024).toFixed(2)}MB` : '32MB';
        
        return res.status(413).json({ 
          error: '檔案大小超過限制',
          currentSize: receivedSize,
          maxSize: maxSize,
          details: err.message,
          suggestions: [
            '檔案會自動壓縮和分割處理',
            '如果持續失敗，請嘗試使用較小的音檔',
            '建議使用 30MB 以下的音檔以獲得最佳體驗'
          ]
        });
      }
      
      return res.status(400).json({ 
        error: `表單解析失敗: ${err.message}`,
        details: err.code || 'UNKNOWN_ERROR',
        suggestion: '請檢查檔案格式和大小'
      });
    }
    
    // 詳細日誌：記錄接收到的檔案資訊
    console.log('接收到的檔案資訊:');
    console.log('  - files.audio 是否存在:', !!files.audio?.[0]);
    if (files.audio?.[0]) {
      console.log('  - 原始檔案名:', files.audio[0].originalFilename);
      console.log('  - MIME 類型:', files.audio[0].mimetype);
      console.log('  - 檔案大小:', `${(files.audio[0].size / 1024 / 1024).toFixed(2)}MB`);
      console.log('  - 臨時檔案路徑:', files.audio[0].filepath);
    } else {
      console.error('  - 錯誤: 沒有找到 audio 檔案');
      console.error('  - 接收到的 files keys:', Object.keys(files));
      console.error('  - 接收到的 fields keys:', Object.keys(fields));
    }
    
    const audioFile = files.audio?.[0];
    const title = fields.title?.[0] || 'Unknown';
    const episodeId = fields.episodeId?.[0] || 'unknown';
    const sourceLanguage = fields.sourceLanguage?.[0] || 'auto'; // 新增：獲取語言參數，預設為 auto
    const outputFormats = fields.outputFormats?.[0]?.split(',') || ['txt'];
    const contentType = fields.contentType?.[0] || 'podcast';
    const enableSpeakerDiarization = fields.enableSpeakerDiarization?.[0] === 'true';
    // 新增：接收 keywords 參數，並限制長度為 400 字元（避免超過 OpenAI 的 224 tokens 限制）
    let keywords = fields.keywords?.[0] || '';
    if (keywords && keywords.length > 400) {
      keywords = keywords.substring(0, 400);
      console.log('⚠️ keywords 超過 400 字元，已自動截斷');
    }

    if (!audioFile) {
      console.error('❌ 沒有找到音檔');
      console.error('接收到的 files:', JSON.stringify(Object.keys(files), null, 2));
      console.error('接收到的 fields:', JSON.stringify(Object.keys(fields), null, 2));
      return res.status(400).json({ 
        error: '沒有找到音檔',
        details: 'FormData 中沒有找到 audio 欄位',
        suggestion: '請確認前端正確使用 FormData.append("audio", blob) 上傳檔案'
      });
    }
    
    // 檢查檔案大小
    if (audioFile.size > 30 * 1024 * 1024) {
      console.error(`❌ 檔案太大: ${(audioFile.size / 1024 / 1024).toFixed(2)}MB`);
      return res.status(413).json({ 
        error: '檔案大小超過限制',
        currentSize: `${(audioFile.size / 1024 / 1024).toFixed(2)}MB`,
        maxSize: '30MB',
        suggestions: [
          '檔案會自動壓縮和分割處理',
          '如果持續失敗，請嘗試使用較小的音檔'
        ]
      });
    }
    
    // 檢查檔案是否為空
    if (audioFile.size === 0) {
      console.error('❌ 檔案為空');
      return res.status(400).json({ 
        error: '上傳的檔案為空',
        suggestion: '請確認音檔下載完整'
      });
    }
    
    console.log(`✅ 音檔驗證通過: ${(audioFile.size / 1024 / 1024).toFixed(2)}MB, 類型: ${audioFile.mimetype || '未知'}`);

    const fileSizeMB = (audioFile.size / 1024 / 1024).toFixed(2);
    const estimatedDuration = Math.ceil((audioFile.size / 1024 / 1024) * 0.5); // 粗略估算：1MB ≈ 0.5 分鐘
    console.log(`\n📋 轉錄任務資訊:`);
    console.log(`  標題: ${title}`);
    console.log(`  檔案大小: ${fileSizeMB}MB`);
    console.log(`  預估時長: 約 ${estimatedDuration} 分鐘`);
    console.log(`  輸出格式: ${outputFormats.join(', ')}`);
    console.log(`  內容類型: ${contentType}`);
    console.log(`  說話者分離: ${enableSpeakerDiarization ? '啟用' : '停用'}`);
    logMemoryUsage('任務開始');
    
    addTranscriptionLog(episodeId, 'info', `檔案大小: ${fileSizeMB}MB，預估時長: 約 ${estimatedDuration} 分鐘`, '任務資訊');
    addTranscriptionLog(episodeId, 'info', `輸出格式: ${outputFormats.join(', ')}, 內容類型: ${contentType}`, '任務資訊');

    // 新增：驗證和正規化音檔格式
    try {
      console.log('=== 音檔格式驗證開始 ===');
      console.log(`原始檔案路徑: ${audioFile.filepath}`);
      console.log(`原始檔案名稱: ${audioFile.originalFilename || audioFile.name}`);
      
      // 驗證和正規化檔案格式
      const normalizedFilePath = validateAndNormalizeAudioFile(audioFile.filepath);
      audioFile.filepath = normalizedFilePath;
      
      // 驗證檔案內容
      validateAudioFileContent(audioFile.filepath);
      
      console.log(`✅ 音檔格式驗證通過: ${audioFile.filepath}`);
      console.log('=== 音檔格式驗證完成 ===');
      
    } catch (validationError) {
      console.error('=== 音檔格式驗證失敗 ===');
      console.error('驗證錯誤:', validationError);
      
      // 清理上傳的檔案
      try {
        fs.unlinkSync(audioFile.filepath);
      } catch (cleanupError) {
        console.warn('清理無效檔案失敗:', cleanupError);
      }
      
      return res.status(400).json({
        error: `音檔格式驗證失敗: ${validationError.message}`,
        suggestions: [
          '請確保檔案是有效的音檔格式',
          '支援格式: MP3, WAV, M4A, FLAC, OGG, WebM',
          '檢查檔案是否完整下載',
          '嘗試使用其他音檔轉換工具重新編碼'
        ]
      });
    }

    // OpenAI Whisper 限制為 25MB，超出則自動處理
    const OPENAI_LIMIT = 25 * 1024 * 1024;
    let processedAudio;
    
    if (audioFile.size > OPENAI_LIMIT) {
      const fileSizeMB = (audioFile.size / 1024 / 1024).toFixed(2);
      console.log(`\n🔧 [階段 1/4] 音檔處理開始`);
      console.log(`  音檔大小 ${fileSizeMB}MB 超過 25MB，啟動自動處理...`);
      const processingStartTime = Date.now();
      logMemoryUsage('音檔處理開始');
      addTranscriptionLog(episodeId, 'info', `[階段 1/4] 音檔處理開始 - 檔案大小 ${fileSizeMB}MB 超過 25MB，啟動自動處理`, '音檔處理');
      
      try {
        try { 
          processedAudio = await processLargeAudio(audioFile, title); 
          const processingDuration = ((Date.now() - processingStartTime) / 1000).toFixed(2);
          console.log(`✅ [階段 1/4] 音檔處理完成，耗時: ${processingDuration} 秒`);
          logMemoryUsage('音檔處理完成');
          addTranscriptionLog(episodeId, 'success', `[階段 1/4] 音檔處理完成，耗時: ${processingDuration} 秒`, '音檔處理');
          if (processedAudio.type === 'segments') {
            addTranscriptionLog(episodeId, 'info', `音檔已分割為 ${processedAudio.totalSegments} 個片段`, '音檔處理');
          }
        } catch (ffmpegError) { 
          if (ffmpegError.message.includes("ffmpeg") || ffmpegError.message.includes("ENOENT")) { 
            console.error("FFmpeg 不可用:", ffmpegError.message); 
            return res.status(413).json({ 
              error: "音檔大小超過限制，且伺服器音檔處理功能不可用", 
              message: "請手動壓縮音檔", 
              suggestions: [
                "使用音訊編輯軟體壓縮至25MB以下", 
                "降低音質至128kbps或更低", 
                "分割成較短片段", 
                "轉換為MP3格式"
              ], 
              currentSize: fileSizeMB + "MB", 
              maxSize: "25MB" 
            }); 
          } 
          throw ffmpegError; 
        }
        console.log(`  處理結果類型: ${processedAudio.type}`);
        if (processedAudio.type === 'segments') {
          console.log(`  片段數量: ${processedAudio.totalSegments}`);
        }
      } catch (error) {
        console.error('\n❌ [階段 1/4] 音檔處理失敗');
        console.error('錯誤詳情:', error);
        console.error('錯誤堆疊:', error.stack);
        logMemoryUsage('音檔處理失敗');
        addTranscriptionLog(episodeId, 'error', `[階段 1/4] 音檔處理失敗: ${error.message}`, '錯誤');
        return res.status(500).json({
          error: `音檔處理失敗: ${error.message}`,
          suggestions: [
            '請檢查音檔格式是否正確',
            '嘗試使用標準的 MP3 或 WAV 格式',
            '確保音檔沒有損壞'
          ]
        });
      }
    } else {
      // 檔案大小符合限制，直接使用原檔案
      processedAudio = {
        type: 'single',
        file: audioFile.filepath,
        size: audioFile.size
      };
    }

    // 檢查 OpenAI API 金鑰
    if (!process.env.OPENAI_API_KEY) {
      console.error('OpenAI API 金鑰未設置');
      return res.status(500).json({ 
        error: 'OpenAI API 金鑰未設置' 
      });
    }

    console.log(`\n🎤 [階段 2/4] 開始轉錄`);
    console.log(`  OpenAI API 端點: ${openai.baseURL}`);
    const transcriptionStartTime = Date.now();
    logMemoryUsage('轉錄開始');
    addTranscriptionLog(episodeId, 'info', `[階段 2/4] 開始轉錄 - OpenAI API 端點: ${openai.baseURL}`, '轉錄');
    
    try {
      let finalTranscription;
      
      // 確定使用的語言（用於生成提示詞，如果 auto 則使用 zh 作為預設）
      const promptLanguage = sourceLanguage === 'auto' ? 'zh' : sourceLanguage;
      
      // 生成優化的提示詞
      let optimizedPrompt = TranscriptionOptimizer.generateOptimizedPrompt(promptLanguage, contentType);
      
      // 新增：如果有 keywords，將其合併到 prompt 中
      if (keywords && keywords.trim()) {
        // 將 keywords 加到 prompt 前面，用換行分隔
        optimizedPrompt = `${keywords.trim()}\n\n${optimizedPrompt}`;
        // 再次檢查長度，確保不超過限制（約 224 tokens，約 400 字元）
        if (optimizedPrompt.length > 400) {
          // 如果合併後超過限制，優先保留 keywords，截斷後面的內容
          const keywordsPart = keywords.trim();
          const remainingLength = 400 - keywordsPart.length - 2; // 減去換行符
          if (remainingLength > 0) {
            const basePrompt = TranscriptionOptimizer.generateOptimizedPrompt(promptLanguage, contentType);
            optimizedPrompt = `${keywordsPart}\n\n${basePrompt.substring(0, remainingLength)}`;
          } else {
            optimizedPrompt = keywordsPart.substring(0, 400);
          }
          console.log('⚠️ 合併後的 prompt 超過 400 字元，已自動截斷');
        }
        console.log(`使用優化提示詞（含關鍵字）: ${optimizedPrompt.substring(0, 100)}...`);
      } else {
      console.log(`使用優化提示詞: ${optimizedPrompt}`);
      }
      
      // 記錄語言設置
      console.log(`語言設置: ${sourceLanguage === 'auto' ? '自動檢測' : sourceLanguage}`);
      addTranscriptionLog(episodeId, 'info', `語言設置: ${sourceLanguage === 'auto' ? '自動檢測' : sourceLanguage}`, '初始化');
      
      if (processedAudio.type === 'single') {
        // 單一檔案轉錄（帶重試機制）
        console.log('  轉錄模式: 單一檔案');
        const segmentStartTime = Date.now();
        addTranscriptionLog(episodeId, 'info', '轉錄模式: 單一檔案', '轉錄');
        
        let transcription;
        let retryCount = 0;
        const maxRetries = 5; // 增加重試次數
        
        while (retryCount < maxRetries) {
          try {
            console.log(`  正在呼叫 OpenAI API... (嘗試 ${retryCount + 1}/${maxRetries})`);
            addTranscriptionLog(episodeId, 'info', `正在呼叫 OpenAI API (whisper-1)... (嘗試 ${retryCount + 1}/${maxRetries})`, '轉錄');
            
            // 每次重試都重新創建文件流
            const transcriptionParams = {
              file: fs.createReadStream(processedAudio.file),
              model: 'whisper-1',
              response_format: 'verbose_json',
              timestamp_granularities: ['word'],
              prompt: optimizedPrompt
            };
            
            // 只有當不是 'auto' 時才傳遞 language 參數
            if (sourceLanguage && sourceLanguage !== 'auto') {
              transcriptionParams.language = sourceLanguage;
              console.log(`  使用指定語言: ${sourceLanguage}`);
            } else {
              console.log('  使用自動語言檢測');
            }
            
            transcription = await openai.audio.transcriptions.create(transcriptionParams);
            
            const segmentDuration = ((Date.now() - segmentStartTime) / 1000).toFixed(2);
            console.log(`  ✅ 使用 whisper-1 模型轉錄成功，耗時: ${segmentDuration} 秒`);
            addTranscriptionLog(episodeId, 'success', `使用 whisper-1 模型轉錄成功，耗時: ${segmentDuration} 秒`, '轉錄');
            break; // 成功，跳出重試循環
            
          } catch (modelError) {
            retryCount++;
            
            // 檢測 API 額度錯誤
            const quotaCheck = detectQuotaError(modelError);
            
            // 記錄詳細錯誤信息
            console.error(`  ❌ API 調用錯誤 (嘗試 ${retryCount}/${maxRetries}):`, modelError.message);
            
            if (quotaCheck.isQuotaError) {
              console.error(`  ⚠️ 檢測到 API 額度/用量問題: ${quotaCheck.errorType}`);
              console.error(`  💡 提示: ${quotaCheck.userMessage}`);
              addTranscriptionLog(episodeId, 'error', `⚠️ ${quotaCheck.userMessage}`, '錯誤');
              addTranscriptionLog(episodeId, 'info', `💡 請檢查 OpenAI 帳戶: https://platform.openai.com/usage`, '建議');
              
              // 如果是餘額或認證問題，不重試，直接拋出
              if (!quotaCheck.shouldRetry) {
                const enhancedError = new Error(quotaCheck.userMessage);
                enhancedError.isQuotaError = true;
                enhancedError.errorType = quotaCheck.errorType;
                enhancedError.originalError = modelError;
                throw enhancedError;
              }
            } else {
              // 記錄其他錯誤詳情
              if (modelError.response) {
                const status = modelError.response.status;
                const statusText = modelError.response.statusText;
                const errorData = modelError.response.data || {};
                console.error(`  API 響應錯誤: ${status} ${statusText}`, errorData);
                addTranscriptionLog(episodeId, 'error', `API 錯誤: ${status} ${statusText} - ${errorData.error?.message || modelError.message}`, '轉錄');
              } else if (modelError.cause?.errno) {
                console.error(`  連接錯誤: ${modelError.cause.errno} (${modelError.cause.type})`);
                addTranscriptionLog(episodeId, 'error', `連接錯誤: ${modelError.cause.errno} - ${modelError.message}`, '轉錄');
              } else {
                addTranscriptionLog(episodeId, 'error', `API 錯誤: ${modelError.message}`, '轉錄');
              }
            }
            
            if (retryCount >= maxRetries) {
              console.error(`  ❌ 轉錄失敗，已重試 ${maxRetries} 次`);
              addTranscriptionLog(episodeId, 'error', `轉錄失敗，已重試 ${maxRetries} 次: ${modelError.message}`, '錯誤');
              
              // 如果是最後一次重試且是連接錯誤，給出額度檢查建議
              if (modelError.cause?.errno === 'ECONNRESET') {
                addTranscriptionLog(episodeId, 'info', `💡 建議：請檢查 OpenAI 帳戶的 API 餘額和用量限制`, '建議');
              }
              
              throw modelError;
            } else {
              // 對於連接錯誤，使用更長的重試延遲
              const baseDelay = (modelError.cause?.errno === 'ECONNRESET' || quotaCheck.isQuotaError) ? 5000 : 2000;
              const retryDelay = Math.min(baseDelay * Math.pow(2, retryCount - 1), 30000);
              console.warn(`  ⚠️ ${retryDelay / 1000} 秒後重試... (${retryCount}/${maxRetries})`);
              addTranscriptionLog(episodeId, 'warn', `${retryDelay / 1000} 秒後重試... (${retryCount}/${maxRetries})`, '轉錄');
              await new Promise(resolve => setTimeout(resolve, retryDelay));
            }
          }
        }
        
        finalTranscription = transcription;
        
      } else {
        // 多片段轉錄 - 使用並行處理加速，同時處理多個片段
        console.log(`  轉錄模式: 多片段（共 ${processedAudio.totalSegments} 個片段）`);
        const totalSegments = processedAudio.files.length;
        const CONCURRENT_LIMIT = 3; // 同時處理 3 個片段（可調整）
        const SEGMENT_DURATION = 300; // 固定片段時長：5 分鐘（300 秒）
        
        console.log(`  🚀 啟用並行處理模式，同時處理 ${CONCURRENT_LIMIT} 個片段`);
        addTranscriptionLog(episodeId, 'info', `啟用並行處理模式，同時處理 ${CONCURRENT_LIMIT} 個片段`, '轉錄');
        
        // 處理單個片段的函數（帶重試機制）
        async function processSegmentWithRetry(segmentFile, segmentIndex, totalSegments) {
          const segmentStartTime = Date.now();
          console.log(`\n  📝 片段 ${segmentIndex}/${totalSegments}: ${path.basename(segmentFile)}`);
          logMemoryUsage(`片段 ${segmentIndex} 開始`);
          addTranscriptionLog(episodeId, 'info', `片段 ${segmentIndex}/${totalSegments}: ${path.basename(segmentFile)}`, '轉錄');
          
          let transcription;
          let retryCount = 0;
          const maxRetries = 3;
          
          while (retryCount < maxRetries) {
            try {
              console.log(`    正在呼叫 OpenAI API... (嘗試 ${retryCount + 1}/${maxRetries})`);
              addTranscriptionLog(episodeId, 'info', `片段 ${segmentIndex} 正在呼叫 OpenAI API... (嘗試 ${retryCount + 1}/${maxRetries})`, '轉錄');
              
              // 構建轉錄參數
              const transcriptionParams = {
                file: fs.createReadStream(segmentFile),
                model: 'whisper-1',
                response_format: 'verbose_json',
                timestamp_granularities: ['word'],
                prompt: optimizedPrompt
              };
              
              // 只有當不是 'auto' 時才傳遞 language 參數
              if (sourceLanguage && sourceLanguage !== 'auto') {
                transcriptionParams.language = sourceLanguage;
              }
              
              transcription = await openai.audio.transcriptions.create(transcriptionParams);
              break; // 成功，跳出重試循環
            } catch (modelError) {
              retryCount++;
              
              // 檢測 API 額度錯誤
              const quotaCheck = detectQuotaError(modelError);
              
              // 記錄詳細錯誤信息
              console.error(`    ❌ API 調用錯誤 (嘗試 ${retryCount}/${maxRetries}):`, modelError.message);
              
              if (quotaCheck.isQuotaError) {
                console.error(`    ⚠️ 檢測到 API 額度/用量問題: ${quotaCheck.errorType}`);
                console.error(`    💡 提示: ${quotaCheck.userMessage}`);
                addTranscriptionLog(episodeId, 'error', `⚠️ ${quotaCheck.userMessage}`, '錯誤');
                addTranscriptionLog(episodeId, 'info', `💡 請檢查 OpenAI 帳戶: https://platform.openai.com/usage`, '建議');
                
                // 如果是餘額或認證問題，不重試，直接拋出
                if (!quotaCheck.shouldRetry) {
                  const enhancedError = new Error(quotaCheck.userMessage);
                  enhancedError.isQuotaError = true;
                  enhancedError.errorType = quotaCheck.errorType;
                  enhancedError.originalError = modelError;
                  throw enhancedError;
                }
              } else {
                // 記錄其他錯誤詳情
                if (modelError.response) {
                  const status = modelError.response.status;
                  const statusText = modelError.response.statusText;
                  const errorData = modelError.response.data || {};
                  console.error(`    API 響應錯誤: ${status} ${statusText}`, errorData);
                  addTranscriptionLog(episodeId, 'error', `API 錯誤: ${status} ${statusText} - ${errorData.error?.message || modelError.message}`, '轉錄');
                } else if (modelError.cause?.errno) {
                  console.error(`    連接錯誤: ${modelError.cause.errno} (${modelError.cause.type})`);
                  addTranscriptionLog(episodeId, 'error', `連接錯誤: ${modelError.cause.errno} - ${modelError.message}`, '轉錄');
                } else if (modelError.code) {
                  console.error(`    錯誤代碼: ${modelError.code}`);
                  addTranscriptionLog(episodeId, 'error', `API 錯誤: ${modelError.code} - ${modelError.message}`, '轉錄');
                } else {
                  addTranscriptionLog(episodeId, 'error', `API 錯誤: ${modelError.message}`, '轉錄');
                }
              }
              
              if (retryCount >= maxRetries) {
                console.error(`    ❌ 轉錄失敗，已重試 ${maxRetries} 次`);
                addTranscriptionLog(episodeId, 'error', `轉錄失敗，已重試 ${maxRetries} 次: ${modelError.message}`, '錯誤');
                
                // 如果是最後一次重試且是連接錯誤，給出額度檢查建議
                if (modelError.cause?.errno === 'ECONNRESET') {
                  addTranscriptionLog(episodeId, 'info', `💡 建議：請檢查 OpenAI 帳戶的 API 餘額和用量限制`, '建議');
                }
                
                throw modelError;
              } else {
                // 對於連接錯誤或額度問題，使用更長的重試延遲
                const baseDelay = (modelError.cause?.errno === 'ECONNRESET' || quotaCheck.isQuotaError) ? 5000 : 2000;
                const retryDelay = Math.min(baseDelay * Math.pow(2, retryCount - 1), 30000);
                console.warn(`    ⚠️ ${retryDelay / 1000} 秒後重試... (${retryCount}/${maxRetries})`);
                addTranscriptionLog(episodeId, 'warn', `${retryDelay / 1000} 秒後重試... (${retryCount}/${maxRetries})`, '轉錄');
                await new Promise(resolve => setTimeout(resolve, retryDelay));
              }
            }
          }
          
          const segmentDuration = ((Date.now() - segmentStartTime) / 1000).toFixed(2);
          console.log(`    ✅ 片段 ${segmentIndex} 轉錄完成，耗時: ${segmentDuration} 秒`);
          logMemoryUsage(`片段 ${segmentIndex} 完成`);
          addTranscriptionLog(episodeId, 'success', `片段 ${segmentIndex} 轉錄完成，耗時: ${segmentDuration} 秒`, '轉錄');
          
          return { index: segmentIndex - 1, transcription }; // index 從 0 開始
        }
        
        // 並行處理所有片段，但限制並發數
        const results = [];
        const activePromises = new Set();
        
        async function processWithConcurrencyLimit(segmentFile, segmentIndex, totalSegments) {
          // 如果達到並發限制，等待至少一個完成
          while (activePromises.size >= CONCURRENT_LIMIT) {
            await Promise.race(Array.from(activePromises));
          }
          
          const promise = processSegmentWithRetry(segmentFile, segmentIndex, totalSegments)
            .then(result => {
              results.push(result);
              activePromises.delete(promise);
              return result;
            })
            .catch(error => {
              console.error(`片段 ${segmentIndex} 處理失敗:`, error);
              addTranscriptionLog(episodeId, 'error', `片段 ${segmentIndex} 處理失敗: ${error.message}`, '錯誤');
              activePromises.delete(promise);
              // 返回一個錯誤標記，後續處理時可以跳過
              return { index: segmentIndex - 1, error: error.message };
            });
          
          activePromises.add(promise);
          return promise;
        }
        
        // 啟動所有片段的處理
        const allPromises = [];
        for (let i = 0; i < processedAudio.files.length; i++) {
          allPromises.push(processWithConcurrencyLimit(processedAudio.files[i], i + 1, totalSegments));
        }
        
        // 等待所有片段完成
        await Promise.all(allPromises);
        
        // 按順序合併結果
        results.sort((a, b) => a.index - b.index);
        
        let mergedResult = {
          text: '',
          duration: 0,
          segments: [],
          totalSegments: 0
        };
        
        // 使用固定片段時長計算偏移，確保時間戳準確
        let cumulativeOffset = 0;
        
        for (const result of results) {
          if (result.error) {
            console.error(`⚠️ 片段 ${result.index + 1} 處理失敗，跳過: ${result.error}`);
            // 即使失敗，也要累加固定時長，保持後續片段時間戳正確
            cumulativeOffset += SEGMENT_DURATION;
            continue;
          }
          
          // 使用固定偏移量（基於片段索引）而不是累加的 duration
          // 這樣可以確保時間戳準確，即使 transcription.duration 不準確
          const segmentOffset = result.index * SEGMENT_DURATION;
          
          mergedResult = mergeTranscriptionIncrementalWithOffset(
            mergedResult, 
            result.transcription, 
            result.index + 1, 
            totalSegments,
            segmentOffset,
            result.actualDuration || SEGMENT_DURATION
          );
          
          // 累加實際時長（用於總時長計算）
          cumulativeOffset += (result.actualDuration || SEGMENT_DURATION);
        }
        
        // 更新總時長為累加的實際時長
        mergedResult.duration = cumulativeOffset;
        
        finalTranscription = mergedResult;
        console.log(`\n  ✅ 所有片段轉錄並合併完成，共 ${totalSegments} 個片段`);
        addTranscriptionLog(episodeId, 'success', `所有片段轉錄並合併完成，共 ${totalSegments} 個片段`, '轉錄');
      }
      
      const transcriptionDuration = ((Date.now() - transcriptionStartTime) / 1000 / 60).toFixed(2);
      console.log(`✅ [階段 2/4] 轉錄完成，總耗時: ${transcriptionDuration} 分鐘`);
      logMemoryUsage('轉錄完成');
      addTranscriptionLog(episodeId, 'success', `[階段 2/4] 轉錄完成，總耗時: ${transcriptionDuration} 分鐘`, '轉錄');
      

      // 新增：自動錯字檢查與修正
      console.log(`\n🔍 [階段 3/4] 開始錯字檢查與修正`);
      const spellCheckStartTime = Date.now();
      logMemoryUsage('錯字檢查開始');
      addTranscriptionLog(episodeId, 'info', '[階段 3/4] 開始錯字檢查與修正', '錯字檢查');
      let correctedTranscription = finalTranscription;
      try {
        correctedTranscription = await checkAndCorrectSpelling(finalTranscription, finalTranscription.language || 'zh', contentType);
        const spellCheckDuration = ((Date.now() - spellCheckStartTime) / 1000).toFixed(2);
        console.log(`✅ [階段 3/4] 錯字檢查完成，耗時: ${spellCheckDuration} 秒`);
        logMemoryUsage('錯字檢查完成');
        addTranscriptionLog(episodeId, 'success', `[階段 3/4] 錯字檢查完成，耗時: ${spellCheckDuration} 秒`, '錯字檢查');
      } catch (spellCheckError) {
        console.warn(`⚠️ [階段 3/4] 錯字檢查失敗，使用原始轉錄結果: ${spellCheckError.message}`);
        logMemoryUsage('錯字檢查失敗');
        addTranscriptionLog(episodeId, 'warn', `[階段 3/4] 錯字檢查失敗，使用原始轉錄結果: ${spellCheckError.message}`, '錯字檢查');
        // 繼續使用原始轉錄結果
      }

      // 處理說話者分離（使用修正後的轉錄結果）
      if (enableSpeakerDiarization && correctedTranscription.segments) {
        console.log('開始處理說話者分離...');
        correctedTranscription.segments = await SpeakerDiarization.simulateSpeakerDetection(correctedTranscription.segments);
      }

      // 使用增強轉錄處理器生成多種輸出格式（使用修正後的轉錄結果）
      console.log(`\n📄 [階段 4/4] 生成多種輸出格式`);
      const formatStartTime = Date.now();
      logMemoryUsage('格式生成開始');
      const processedResult = TranscriptionProcessor.processTranscriptionResult(correctedTranscription, {
        enableSpeakerDiarization,
        outputFormats,
        optimizeSegments: true,
        contentType
      });

      // 清理臨時檔案
      try {
        fs.unlinkSync(audioFile.filepath);
        
        if (processedAudio.type === 'single' && processedAudio.file !== audioFile.filepath) {
          fs.unlinkSync(processedAudio.file);
        } else if (processedAudio.type === 'segments') {
          // 清理片段檔案和目錄
          processedAudio.files.forEach(file => {
            try { fs.unlinkSync(file); } catch (e) {}
          });
          const segmentDir = path.dirname(processedAudio.files[0]);
          try { fs.rmdirSync(segmentDir); } catch (e) {}
          
          // 清理壓縮檔案
          const compressedFile = processedAudio.file;
          if (compressedFile && fs.existsSync(compressedFile)) {
            fs.unlinkSync(compressedFile);
          }
        }
        
        console.log('臨時檔案清理成功');
      } catch (cleanupError) {
        console.warn('清理臨時檔案失敗:', cleanupError);
      }

      const formatDuration = ((Date.now() - formatStartTime) / 1000).toFixed(2);
      console.log(`✅ [階段 4/4] 格式生成完成，耗時: ${formatDuration} 秒`);
      logMemoryUsage('格式生成完成');
      
      const totalDuration = ((Date.now() - requestStartTime) / 1000 / 60).toFixed(2);
      console.log(`\n🎉 轉錄任務完成: ${title}`);
      console.log(`  總耗時: ${totalDuration} 分鐘`);
      console.log(`  文字長度: ${processedResult.formats.txt?.length || 0} 字元`);
      if (processedAudio.type === 'segments') {
        console.log(`  處理片段數: ${processedAudio.totalSegments} 個`);
      }
      logMemoryUsage('任務完成');
      console.log(`=== 轉錄 API 請求結束 ===\n`);
      
      addTranscriptionLog(episodeId, 'success', `🎉 轉錄任務完成！總耗時: ${totalDuration} 分鐘，文字長度: ${processedResult.formats.txt?.length || 0} 字元`, '完成');
      
      // 清理日誌（5 分鐘後）
      cleanupLogs(episodeId);

      // 回傳增強的結果
      res.json({
        success: true,
        episodeId,
        title,
        text: processedResult.formats.txt || '',
        duration: correctedTranscription.duration,
        language: correctedTranscription.language,
        segments: correctedTranscription.segments || [],
        formats: processedResult.formats,
        metadata: {
          processed: processedAudio.type !== 'single',
          totalSegments: processedAudio.type === 'segments' ? processedAudio.totalSegments : 1,
          speakerDiarization: enableSpeakerDiarization,
          contentType,
          outputFormats
        },
        url: null
      });
      
    } catch (error) {
      console.error('=== 轉錄錯誤 ===');
      console.error('錯誤詳情:', error);
      
      // 清理臨時檔案
      try {
        fs.unlinkSync(audioFile.filepath);
        
        if (processedAudio && processedAudio.type === 'single' && processedAudio.file !== audioFile.filepath) {
          fs.unlinkSync(processedAudio.file);
        } else if (processedAudio && processedAudio.type === 'segments') {
          processedAudio.files.forEach(file => {
            try { fs.unlinkSync(file); } catch (e) {}
          });
          const segmentDir = path.dirname(processedAudio.files[0]);
          try { fs.rmdirSync(segmentDir); } catch (e) {}
        }
      } catch (cleanupError) {
        console.warn('錯誤時清理臨時檔案失敗:', cleanupError);
      }
      
      // 根據錯誤類型回傳不同訊息
      if (error.code === 'insufficient_quota') {
        res.status(402).json({ 
          error: 'OpenAI API 額度不足，請檢查帳戶餘額' 
        });
      } else if (error.code === 'invalid_request_error') {
        res.status(400).json({ 
          error: '音檔格式不支援或檔案損壞' 
        });
      } else {
        res.status(500).json({ 
          error: `轉錄失敗: ${error.message}` 
        });
      }
    }
  });
});

// 新增：格式轉換 API
app.post('/api/convert-transcript', (req, res) => {
  console.log('格式轉換 API 請求');
  
  const { transcriptData, outputFormat } = req.body;
  
  if (!transcriptData || !outputFormat) {
    return res.status(400).json({ 
      error: '缺少轉錄數據或輸出格式' 
    });
  }

  try {
    let convertedContent;
    
    switch (outputFormat) {
      case 'srt':
        convertedContent = TranscriptionFormatter.generateSRT(transcriptData);
        break;
      case 'vtt':
        convertedContent = TranscriptionFormatter.generateVTT(transcriptData);
        break;
      case 'json':
        convertedContent = TranscriptionFormatter.generateJSON(transcriptData);
        break;
      case 'txt':
      default:
        convertedContent = TranscriptionFormatter.generatePlainText(transcriptData);
        break;
    }

    res.json({
      success: true,
      format: outputFormat,
      content: convertedContent
    });
    
  } catch (error) {
    console.error('格式轉換錯誤:', error);
    res.status(500).json({ 
      error: `格式轉換失敗: ${error.message}` 
    });
  }
});

// 新增：從逐字稿生成行銷內容 API
app.post('/api/generate-content', async (req, res) => {
  console.log('行銷內容生成 API 請求');

  if (!process.env.OPENAI_API_KEY || !openai) {
    return res.status(500).json({
      error: 'OpenAI API 金鑰未設置，無法生成行銷內容'
    });
  }

  const { episodeId, title, transcriptText, segments, durationSeconds, language = 'zh' } = req.body || {};

  if (!transcriptText || typeof transcriptText !== 'string' || transcriptText.trim().length < 20) {
    return res.status(400).json({
      error: '缺少足夠的逐字稿內容，無法生成行銷內容'
    });
  }

  try {
    console.log(`開始為集數生成行銷內容: ${title || episodeId || 'Unknown'}`);

    const approxDuration = durationSeconds && Number.isFinite(durationSeconds)
      ? `${Math.round(durationSeconds / 60)} 分鐘`
      : '未知時長';

    // 如果有 segments，建立時間戳對照表
    let timeReference = '';
    if (segments && Array.isArray(segments) && segments.length > 0) {
      timeReference = '\n\n【時間戳參考資料】（請使用這些真實時間點來生成時間軸，不要自行估算）：\n';
      // 取前 30 個片段作為參考（避免 prompt 太長）
      const segmentsToShow = segments.slice(0, 30);
      segmentsToShow.forEach((seg, idx) => {
        const startMin = Math.floor(seg.start / 60);
        const startSec = Math.floor(seg.start % 60);
        const endMin = Math.floor(seg.end / 60);
        const endSec = Math.floor(seg.end % 60);
        timeReference += `${idx + 1}. [${startMin}:${startSec.toString().padStart(2, '0')} - ${endMin}:${endSec.toString().padStart(2, '0')}] ${(seg.text || '').substring(0, 150)}\n`;
      });
      if (segments.length > 30) {
        timeReference += `...（還有 ${segments.length - 30} 個片段，請根據內容推斷時間點）\n`;
      }
      timeReference += '\n重要：時間軸中的時間點必須使用上述真實時間戳，格式為 MM:SS。\n';
    }

    const systemPrompt = language === 'zh'
      ? '你是一位專業的 Podcast 行銷與內容編輯，負責根據逐字稿產生時間軸、節目簡介、吸引人的標題，以及 Threads / Facebook / Instagram 貼文文案。你的文字必須：1) 完全沒有錯字、語法錯誤或標點符號錯誤 2) 語氣自然、口語但專業 3) 目標受眾是對科技與學習有興趣的大眾 4) 時間軸必須使用提供的真實時間戳，絕對不要自行估算 5) 貼文要有吸引力、專業且自然，避免過度行銷感。'
      : 'You are a professional podcast marketer and copywriter. Based on the transcript, you will generate a timeline, show description, catchy titles, and social media posts. Your text must be error-free, natural, and professional. Use real timestamps for the timeline.';

    const userPrompt = `
請根據以下 Podcast 逐字稿，產生一組結構化的行銷內容。

節目資訊：
- 節目標題（可視為原始標題，僅供參考）：${title || '未提供'}
- 約略時長：${approxDuration}
${timeReference}
逐字稿內容（可能較長，請完整閱讀後再統整重點）：
---
${transcriptText}
---

請你回傳「JSON 物件」（不要額外加說明文字），結構嚴格符合以下格式：
{
  "timeline": [
    {
      "label": "章節名稱或主題，例如：開場與自我介紹",
      "time": "真實時間點（格式：MM:SS，例如 00:00 或 05:30）。${segments && segments.length > 0 ? '請使用上方【時間戳參考資料】中的真實時間，絕對不要自行估算。' : '可粗略估計，但盡量準確。'}",
      "summary": "1-3 句，說明這一段在講什麼、重點是什麼"
    }
  ],
  "description": "1-3 個段落的節目簡介，適合放在節目說明欄，語氣自然、可口語一點，但要清楚讓第一次看到的人知道這集在講什麼、適合誰聽。請確保完全沒有錯字、語法錯誤。",
  "titleOptions": [
    "一個很吸引人的標題，適合 Podcast / YouTube 封面使用，15-30 字，要有記憶點、能引起好奇心",
    "再給 1-2 個不同角度但同樣吸引人的備選標題"
  ],
  "socialPosts": {
    "threads": "一則適合 Threads 的貼文，可以稍微有個性、分 2-3 行，最後附上行動呼籲（例如：來聽完整節目、留言分享看法）。語氣要自然、有吸引力，完全沒有錯字。長度約 100-200 字。",
    "facebook": "一則適合 Facebook 的貼文，篇幅可以稍長一點（150-300 字），有明確的故事感或重點條列，最後附上 CTA。語氣專業但親切，完全沒有錯字。",
    "instagram": "一則適合 IG 貼文說明文字（非限時動態），可以搭配圖片或 Reels 使用，語氣親切、可以加入適量 emoji（3-5 個）與 5-8 個相關 hashtag。完全沒有錯字。長度約 150-250 字。"
  }
}

特別注意：
- 請務必產出符合上述 key 的標準 JSON（不要多加其他欄位）。
- 所有文字請使用繁體中文。
- 請仔細檢查所有文字，確保完全沒有錯字、語法錯誤或標點符號錯誤。
- 時間軸的時間點${segments && segments.length > 0 ? '必須使用【時間戳參考資料】中的真實時間戳' : '可粗略估計'}，格式為 MM:SS。
- 貼文要有吸引力、專業且自然，避免過度行銷感或過於生硬的推銷語氣。
- 標題要有記憶點，能引起目標受眾的好奇心。
`;

    // 嘗試使用 GPT-5.2，如果失敗則嘗試 GPT-5 mini，最後回退到 gpt-4o
    let completion;
    const modelsToTry = ['gpt-5.2', 'gpt-5-mini', 'gpt-4o'];
    let lastError = null;
    
    for (const model of modelsToTry) {
      try {
        completion = await openai.chat.completions.create({
          model: model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.7, // 控制創造力，0.7 平衡創造力與準確性
        });
        console.log(`✅ 使用 ${model} 模型生成行銷內容成功`);
        break;
      } catch (modelError) {
        console.warn(`⚠️ ${model} 不可用，嘗試下一個模型:`, modelError.message);
        lastError = modelError;
        continue;
      }
    }
    
    if (!completion) {
      throw lastError || new Error('所有模型都不可用');
    }

    const raw = completion.choices?.[0]?.message?.content || '{}';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.warn('行銷內容 JSON 解析失敗，嘗試包一層:', e);
      parsed = { rawText: raw };
    }

    res.json({
      success: true,
      episodeId,
      title,
      content: parsed
    });
  } catch (error) {
    console.error('行銷內容生成失敗:', error);
    res.status(500).json({
      error: `行銷內容生成失敗: ${error.message || String(error)}`
    });
  }
});

// 新增：從逐字稿生成投資分析報告 API
app.post('/api/generate-analysis', async (req, res) => {
  console.log('投資分析報告生成 API 請求');

  if (!process.env.OPENAI_API_KEY || !openai) {
    return res.status(500).json({
      error: 'OpenAI API 金鑰未設置，無法生成投資分析報告'
    });
  }

  const { episodeId, title, transcriptText } = req.body || {};

  if (!transcriptText || typeof transcriptText !== 'string' || transcriptText.trim().length < 20) {
    return res.status(400).json({
      error: '缺少足夠的逐字稿內容，無法生成投資分析報告'
    });
  }

  try {
    console.log(`開始為集數生成投資分析報告: ${title || episodeId || 'Unknown'}`);
    console.log(`逐字稿長度: ${transcriptText.length} 字元`);

    // 估算 token 數（保守估算：中文字符 * 2）
    const estimatedTokens = transcriptText.length * 2;
    console.log(`估算 token 數: ${estimatedTokens}`);
    
    if (estimatedTokens > 100000) {
      console.warn(`⚠️ 逐字稿較長（估算 ${estimatedTokens} tokens），但仍嘗試一次性處理`);
    }

    const systemPrompt = `# Role
你是一位華爾街頂級的科技投資分析師，專門服務避險基金經理人。
你的任務是閱讀一份 Podcast 逐字稿，並從中萃取高價值的市場情報 (Alpha)。

# Goal
請忽略閒聊、廣告和口語贅字，專注於挖掘與「美股、AI 供應鏈、總體經濟」相關的洞察。
請輸出這份報告給基金經理人看。`;

    const userPrompt = `# Input Data
${transcriptText}

# Output Format (請嚴格遵守此 Markdown 格式)

## 1. 市場情緒儀表板 (Sentiment Dashboard)
* **整體情緒：** (看多 Bullish / 看空 Bearish / 中立 Neutral) - 請用一句話解釋原因。
* **提及關鍵公司：**
    * **NVIDIA (NVDA):** (正面/負面/中立) - (簡短理由)
    * **TSMC (TSM):** (正面/負面/中立) - (簡短理由)
    * (列出其他提到的公司...)

## 2. 核心投資洞察 (Key Alpha)
*(請列出 3-5 個最具含金量的論點。每個論點必須包含「邏輯推演」)*
* **論點一：** [標題，例如：Blackwell 晶片延遲其實是利多？]
    * **分析：** 講者認為市場過度反應了延遲問題，實際上需求積壓反而延長了獲利週期...
    * **證據：** 來自逐字稿前段 (約 10% 處)。

## 3. 被忽略的風險與細節 (Hidden Gems)
*(有沒有什麼細節是普通散戶會忽略，但講者特別提到的？)*
* [例如：電力供應可能在 2025 年成為 AI 發展瓶頸]

## 4. 行動建議 (Actionable Advice)
*(基於講者的觀點，投資人現在應該做什麼？)*
* [例如：逢低買入軟體基礎設施股，避開硬體代工]

---

請確保：
1. 所有分析都基於逐字稿的實際內容，不要自行編造
2. 如果逐字稿中沒有提到特定公司或主題，請明確標註「未提及」
3. 邏輯推演要清晰，證據要具體（可引用逐字稿的大致位置）
4. 語氣專業、客觀，符合華爾街分析師的風格`;

    // 嘗試使用 GPT-5.2（最佳推理能力，400K 上下文），如果失敗則嘗試 GPT-5 mini，最後回退到 gpt-4o
    let completion;
    const modelsToTry = ['gpt-5.2', 'gpt-5-mini', 'gpt-4o', 'gpt-4-turbo'];
    let lastError = null;
    
    for (const model of modelsToTry) {
      try {
        console.log(`嘗試使用模型: ${model}`);
        completion = await openai.chat.completions.create({
          model: model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.3, // 較低溫度，確保分析更客觀準確
        });
        console.log(`✅ 使用 ${model} 模型生成投資分析報告成功`);
        break;
      } catch (modelError) {
        console.warn(`⚠️ ${model} 不可用，嘗試下一個模型:`, modelError.message);
        lastError = modelError;
        continue;
      }
    }
    
    if (!completion) {
      throw lastError || new Error('所有模型都不可用');
    }

    const analysisText = completion.choices?.[0]?.message?.content || '';

    if (!analysisText || analysisText.trim().length === 0) {
      throw new Error('GPT 返回的分析報告為空');
    }

    console.log(`✅ 投資分析報告生成成功，長度: ${analysisText.length} 字元`);

    res.json({
      success: true,
      episodeId,
      title,
      analysis: analysisText, // Markdown 格式的報告
      metadata: {
        transcriptLength: transcriptText.length,
        estimatedTokens: estimatedTokens,
        model: completion.model,
        generatedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('投資分析報告生成失敗:', error);
    res.status(500).json({
      error: `投資分析報告生成失敗: ${error.message || String(error)}`
    });
  }
});

// 新增：從逐字稿生成大眾日報版本 API
app.post('/api/generate-public-report', async (req, res) => {
  console.log('大眾日報版本生成 API 請求');

  if (!process.env.OPENAI_API_KEY || !openai) {
    return res.status(500).json({
      error: 'OpenAI API 金鑰未設置，無法生成大眾日報版本'
    });
  }

  const { episodeId, title, transcriptText } = req.body || {};

  if (!transcriptText || typeof transcriptText !== 'string' || transcriptText.trim().length < 20) {
    return res.status(400).json({
      error: '缺少足夠的逐字稿內容，無法生成大眾日報版本'
    });
  }

  try {
    console.log(`開始為集數生成大眾日報版本: ${title || episodeId || 'Unknown'}`);
    console.log(`逐字稿長度: ${transcriptText.length} 字元`);

    // 估算 token 數（保守估算：中文字符 * 2）
    const estimatedTokens = transcriptText.length * 2;
    console.log(`估算 token 數: ${estimatedTokens}`);
    
    if (estimatedTokens > 100000) {
      console.warn(`⚠️ 逐字稿較長（估算 ${estimatedTokens} tokens），但仍嘗試一次性處理`);
    }

    const PROMPT_PUBLIC = `# Role
你是一位風趣幽默的科技專欄作家（類似 Morning Brew 或 The Verge 風格）。
你的讀者是一般大眾、上班族和入門投資人，他們想了解 AI 趨勢，但不想看枯燥的報告。

# Goal
閱讀 Podcast 逐字稿，用「最簡單的大白話」告訴大家最近發生了什麼大事。
**解釋專有名詞，強調對「個人生活、工作與錢包」的影響。**

# Output Format (Markdown)

## 1. 懶人包：這集在聊什麼？
(用輕鬆的口語，像是跟朋友聊天一樣介紹這集重點)

## 2. 關於你的錢包 (投資風向)
* **大公司動態：** (微軟、NVIDIA 最近怎麼了？簡單說是看漲還是看跌？)
* **投資關鍵字：** (本集提到的熱門概念，例如「AI 泡沫」，用白話文解釋是什麼意思)

## 3. 未來生活預告 (Future Life)
*(AI 會怎麼改變我們的生活？)*
* **工作會被取代嗎？** (講者怎麼看未來的就業市場？)
* **新酷科技：** (有什麼新產品或新功能要出來了嗎？)

## 4. 漲知識 (Buzzword Buster)
*(挑選 2-3 個這集出現的難詞，用比喻的方式解釋)*
* **例如：Token Factory (代幣工廠)** -> 想像成是 AI 時代的發電廠...

請用「繁體中文」撰寫，語氣親切、好讀，多用比喻。`;

    const userPrompt = `# Input Data
${transcriptText}

${PROMPT_PUBLIC}

請確保：
1. 所有內容都基於逐字稿的實際內容，不要自行編造
2. 如果逐字稿中沒有提到特定公司或主題，請明確標註「未提及」
3. 用最簡單的大白話解釋，避免專業術語
4. 語氣親切、風趣，像是跟朋友聊天一樣
5. 多用比喻和例子，讓一般大眾也能理解`;

    // 嘗試使用 GPT-5.2（最佳推理能力，400K 上下文），如果失敗則嘗試 GPT-5 mini，最後回退到 gpt-4o
    let completion;
    const modelsToTry = ['gpt-5.2', 'gpt-5-mini', 'gpt-4o', 'gpt-4-turbo'];
    let lastError = null;
    
    for (const model of modelsToTry) {
      try {
        console.log(`嘗試使用模型: ${model}`);
        completion = await openai.chat.completions.create({
          model: model,
          messages: [
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.7, // 較高溫度，確保語氣風趣幽默
        });
        console.log(`✅ 使用 ${model} 模型生成大眾日報版本成功`);
        break;
      } catch (modelError) {
        console.warn(`⚠️ ${model} 不可用，嘗試下一個模型:`, modelError.message);
        lastError = modelError;
        continue;
      }
    }
    
    if (!completion) {
      throw lastError || new Error('所有模型都不可用');
    }

    const reportText = completion.choices?.[0]?.message?.content || '';

    if (!reportText || reportText.trim().length === 0) {
      throw new Error('GPT 返回的大眾日報版本為空');
    }

    console.log(`✅ 大眾日報版本生成成功，長度: ${reportText.length} 字元`);

    res.json({
      success: true,
      episodeId,
      title,
      report: reportText, // Markdown 格式的報告
      metadata: {
        transcriptLength: transcriptText.length,
        estimatedTokens: estimatedTokens,
        model: completion.model,
        generatedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('大眾日報版本生成失敗:', error);
    res.status(500).json({
      error: `大眾日報版本生成失敗: ${error.message || String(error)}`
    });
  }
});

// 新增：AI 聊天 API
app.post('/api/chat', async (req, res) => {
  console.log('AI 聊天 API 請求');

  if (!process.env.OPENAI_API_KEY || !openai) {
    return res.status(500).json({
      error: 'OpenAI API 金鑰未設置，無法使用聊天功能'
    });
  }

  const { episodeId, message, transcriptText, title, episodeIds, transcriptTexts, titles } = req.body || {};

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({
      error: '請提供有效的問題或指令'
    });
  }

  try {
    // 判斷是單集還是多集查詢
    const isMultiEpisode = Array.isArray(episodeIds) && episodeIds.length > 0;
    
    let combinedTranscript = '';
    let combinedTitles = [];
    let totalLength = 0;
    const MAX_TOKENS = 300000; // 最大 token 數（保守估算）
    const SUMMARY_THRESHOLD = 250000; // 摘要閾值（估算 tokens）
    let finalTranscript = '';
    let usedSummary = false;

    if (isMultiEpisode) {
      // 多集查詢
      console.log(`多集查詢模式，共 ${episodeIds.length} 集`);
      
      for (let i = 0; i < episodeIds.length; i++) {
        const text = transcriptTexts[i] || '';
        const epTitle = titles[i] || `集數 ${i + 1}`;
        combinedTranscript += `\n\n=== ${epTitle} ===\n${text}`;
        combinedTitles.push(epTitle);
        totalLength += text.length;
      }
      
      finalTranscript = combinedTranscript;
    } else {
      // 單集查詢
      if (!transcriptText || typeof transcriptText !== 'string' || transcriptText.trim().length < 20) {
        return res.status(400).json({
          error: '缺少足夠的逐字稿內容，無法回答問題'
        });
      }
      
      finalTranscript = transcriptText;
      totalLength = transcriptText.length;
      combinedTitles = [title || 'Unknown'];
    }

    // 估算 token 數（保守估算：中文字符 * 2）
    const estimatedTokens = totalLength * 2;
    console.log(`逐字稿總長度: ${totalLength} 字元，估算 tokens: ${estimatedTokens}`);

    // 如果超過摘要閾值，先進行智能摘要
    if (estimatedTokens > SUMMARY_THRESHOLD) {
      console.log(`⚠️ 逐字稿過長（估算 ${estimatedTokens} tokens），啟動智能摘要...`);
      usedSummary = true;
      
      try {
        const summaries = [];
        
        if (isMultiEpisode) {
          // 多集：分別摘要每一集
          for (let i = 0; i < transcriptTexts.length; i++) {
            const text = transcriptTexts[i] || '';
            const epTitle = titles[i] || `集數 ${i + 1}`;
            
            if (text.trim().length > 0) {
              console.log(`  摘要集數 ${i + 1}: ${epTitle}`);
              
              const summaryPrompt = `請為以下 Podcast 逐字稿生成一個詳細的摘要，保留所有重要信息、關鍵觀點、數據和結論。摘要應該足夠詳細，以便後續可以基於摘要回答具體問題。

逐字稿標題：${epTitle}

逐字稿內容：
${text.substring(0, 200000)}${text.length > 200000 ? '\n\n...（內容已截斷）' : ''}

請生成詳細摘要：`;

              const summaryCompletion = await openai.chat.completions.create({
                model: 'gpt-5.2',
                messages: [
                  { role: 'user', content: summaryPrompt }
                ],
                temperature: 0.3,
              });
              
              const summary = summaryCompletion.choices?.[0]?.message?.content || text.substring(0, 5000);
              summaries.push(`=== ${epTitle} ===\n${summary}`);
            }
          }
        } else {
          // 單集：直接摘要
          console.log(`  摘要單集: ${title || 'Unknown'}`);
          
          const summaryPrompt = `請為以下 Podcast 逐字稿生成一個詳細的摘要，保留所有重要信息、關鍵觀點、數據和結論。摘要應該足夠詳細，以便後續可以基於摘要回答具體問題。

逐字稿標題：${title || 'Unknown'}

逐字稿內容：
${transcriptText.substring(0, 200000)}${transcriptText.length > 200000 ? '\n\n...（內容已截斷）' : ''}

請生成詳細摘要：`;

          const summaryCompletion = await openai.chat.completions.create({
            model: 'gpt-5.2',
            messages: [
              { role: 'user', content: summaryPrompt }
            ],
            temperature: 0.3,
          });
          
          const summary = summaryCompletion.choices?.[0]?.message?.content || transcriptText.substring(0, 5000);
          summaries.push(summary);
        }
        
        finalTranscript = summaries.join('\n\n');
        console.log(`✅ 摘要完成，摘要後長度: ${finalTranscript.length} 字元`);
      } catch (summaryError) {
        console.warn('⚠️ 摘要失敗，使用截斷文本:', summaryError.message);
        // 摘要失敗，使用截斷文本
        finalTranscript = isMultiEpisode 
          ? combinedTranscript.substring(0, 100000)
          : transcriptText.substring(0, 100000);
        usedSummary = false;
      }
    } else {
      finalTranscript = isMultiEpisode ? combinedTranscript : transcriptText;
    }

    // 檢測特殊指令
    const messageLower = message.trim().toLowerCase();
    const isStocksCommand = messageLower.startsWith('/stocks') || 
                           messageLower.includes('投資') || 
                           messageLower.includes('股票') ||
                           messageLower.includes('推薦');
    const isExplainCommand = messageLower.startsWith('/explain') || 
                            messageLower.includes('解釋') || 
                            messageLower.includes('什麼意思') ||
                            messageLower.includes('術語');
    const isFactCheckCommand = messageLower.startsWith('/fact-check') || 
                              messageLower.includes('事實') || 
                              messageLower.includes('查證') ||
                              messageLower.includes('真的嗎');

    // 構建系統提示詞和用戶提示詞
    let systemPrompt = '';
    let userPrompt = '';
    let commandType = 'general';

    if (isStocksCommand) {
      commandType = 'stocks';
      systemPrompt = `你是一位專業的投資分析師，專門分析 Podcast 內容中的投資機會。
你的任務是基於逐字稿內容，識別相關的美股投資標的，並提供投資建議。
請專注於：
1. 識別提到的公司、行業趨勢
2. 分析投資機會和風險
3. 提供具體的投資標的推薦（美股代碼）
4. 說明推薦理由`;
      
      userPrompt = `以下是 Podcast 逐字稿內容：

${finalTranscript}

用戶問題：${message}

請基於以上逐字稿內容，提供投資標的推薦和分析。`;
    } else if (isExplainCommand) {
      commandType = 'explain';
      systemPrompt = `你是一位專業的技術翻譯和解釋專家。
你的任務是將 Podcast 逐字稿中的專業術語和複雜概念，用簡單易懂的方式解釋給一般大眾。
請使用：
1. 簡單的語言和比喻
2. 實際生活中的例子
3. 避免過多專業術語`;
      
      userPrompt = `以下是 Podcast 逐字稿內容：

${finalTranscript}

用戶問題：${message}

請基於以上逐字稿內容，解釋用戶詢問的專業術語或概念。`;
    } else if (isFactCheckCommand) {
      commandType = 'fact-check';
      systemPrompt = `你是一位事實查證專家。
你的任務是基於 Podcast 逐字稿的實際內容，驗證用戶提出的聲明或問題。
請：
1. 直接引用逐字稿中的相關段落
2. 明確說明該聲明是否正確
3. 提供具體的證據（逐字稿引用）`;
      
      userPrompt = `以下是 Podcast 逐字稿內容：

${finalTranscript}

用戶問題或聲明：${message}

請基於以上逐字稿內容，驗證用戶的聲明或回答問題，並提供逐字稿中的具體引用。`;
    } else {
      commandType = 'general';
      systemPrompt = `你是一位專業的 AI 助手，專門回答關於 Podcast 內容的問題。
你的任務是基於提供的逐字稿內容，準確、詳細地回答用戶的問題。
請：
1. 只基於逐字稿的實際內容回答
2. 如果逐字稿中沒有相關信息，明確說明
3. 使用繁體中文回答
4. 回答要清晰、有條理`;
      
      userPrompt = `以下是 Podcast 逐字稿內容：

${finalTranscript}

用戶問題：${message}

請基於以上逐字稿內容回答用戶的問題。`;
    }

    // 調用 OpenAI API
    let completion;
    const modelsToTry = ['gpt-5.2', 'gpt-5-mini', 'gpt-4o', 'gpt-4-turbo'];
    let lastError = null;

    for (const model of modelsToTry) {
      try {
        console.log(`嘗試使用模型: ${model}`);
        completion = await openai.chat.completions.create({
          model: model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.5, // 平衡創造力和準確性
        });
        console.log(`✅ 使用 ${model} 模型生成回答成功`);
        break;
      } catch (modelError) {
        console.warn(`⚠️ ${model} 不可用，嘗試下一個模型:`, modelError.message);
        lastError = modelError;
        continue;
      }
    }

    if (!completion) {
      throw lastError || new Error('所有模型都不可用');
    }

    const answer = completion.choices?.[0]?.message?.content || '抱歉，無法生成回應。';

    if (!answer || answer.trim().length === 0) {
      throw new Error('GPT 返回的回答為空');
    }

    console.log(`✅ AI 聊天回答生成成功，長度: ${answer.length} 字元`);

    res.json({
      success: true,
      answer: answer,
      commandType: commandType,
      usedSummary: usedSummary,
      metadata: {
        transcriptLength: totalLength,
        estimatedTokens: estimatedTokens,
        model: completion.model,
        generatedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('AI 聊天失敗:', error);
    res.status(500).json({
      error: `AI 聊天失敗: ${error.message || String(error)}`
    });
  }
});

// 新增：錯字檢查與修正函數
async function checkAndCorrectSpelling(transcription, language = 'zh', contentType = 'podcast') {
  if (!transcription || !transcription.text) {
    return transcription;
  }

  console.log('🔍 開始錯字檢查，原始文字長度:', transcription.text.length);

  const systemPrompt = language === 'zh'
    ? '你是一位專業的繁體中文校對編輯，負責檢查並修正 Podcast 逐字稿中的錯字、語法錯誤、標點符號錯誤。你的任務是：1) 找出所有錯字、語法錯誤、標點符號錯誤 2) 修正這些錯誤，但保持原始語調和口語風格 3) 不要改變原意或添加內容 4) 如果沒有錯誤，保持原文不變。'
    : 'You are a professional proofreader. Check and correct spelling, grammar, and punctuation errors in the transcript while maintaining the original tone and meaning.';

  const userPrompt = `
請檢查並修正以下 Podcast 逐字稿中的錯字、語法錯誤、標點符號錯誤。

內容類型：${contentType === 'podcast' ? '播客節目' : contentType === 'interview' ? '訪談節目' : '講座/教學'}
語言：繁體中文

原始逐字稿：
---
${transcription.text}
---

${transcription.segments && transcription.segments.length > 0 ? `
時間戳片段（請同時修正這些片段中的錯字）：
${transcription.segments.slice(0, 50).map((seg, idx) => 
  `${idx + 1}. [${Math.floor(seg.start / 60)}:${Math.floor(seg.start % 60).toString().padStart(2, '0')}] ${seg.text}`
).join('\n')}
${transcription.segments.length > 50 ? `...（還有 ${transcription.segments.length - 50} 個片段）` : ''}
` : ''}

請回傳 JSON 物件，格式如下：
{
  "correctedText": "修正後的完整文字（如果沒有錯誤，保持原文）",
  "correctedSegments": [
    {
      "id": "原始 segment 的 id（如果有）",
      "start": 原始時間戳（秒數，保持不變）,
      "end": 原始時間戳（秒數，保持不變）,
      "text": "修正後的片段文字"
    }
  ],
  "corrections": [
    {
      "original": "原始錯誤文字",
      "corrected": "修正後文字",
      "type": "錯字/語法/標點"
    }
  ],
  "hasErrors": true/false
}

特別注意：
- 只修正錯誤，不要改變原意或添加內容
- 保持口語風格和語調
- 如果沒有錯誤，correctedText 和 correctedSegments 保持與原始相同
- 所有文字使用繁體中文
`;

  try {
    // 嘗試使用 GPT-5.2 或 GPT-5 mini，如果失敗則使用 gpt-4o
    const modelsToTry = ['gpt-5.2', 'gpt-5-mini', 'gpt-4o'];
    let completion;
    let lastError = null;

    for (const model of modelsToTry) {
      try {
        completion = await openai.chat.completions.create({
          model: model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.3, // 低溫度確保準確性
        });
        console.log(`✅ 使用 ${model} 進行錯字檢查`);
        break;
      } catch (modelError) {
        console.warn(`⚠️ ${model} 不可用，嘗試下一個模型`);
        lastError = modelError;
        continue;
      }
    }

    if (!completion) {
      throw lastError || new Error('所有模型都不可用');
    }

    const raw = completion.choices?.[0]?.message?.content || '{}';
    const result = JSON.parse(raw);

    if (result.hasErrors && result.correctedText) {
      console.log(`✅ 發現並修正了 ${result.corrections?.length || 0} 處錯誤`);
      
      // 更新轉錄結果
      const corrected = {
        ...transcription,
        text: result.correctedText,
        segments: result.correctedSegments && result.correctedSegments.length > 0
          ? result.correctedSegments.map((seg, idx) => ({
              ...(transcription.segments[idx] || {}),
              ...seg,
              // 保留原始的 words 和其他屬性
              words: transcription.segments[idx]?.words || seg.words
            }))
          : transcription.segments
      };

      return corrected;
    } else {
      console.log('✅ 未發現錯誤，保持原文');
      return transcription;
    }
  } catch (error) {
    console.error('錯字檢查過程發生錯誤:', error);
    throw error;
  }
}

// 輔助函數
function downloadAudio(url, callback, maxRedirects = 5) {
  function downloadWithRedirect(currentUrl, redirectCount = 0) {
    if (redirectCount > maxRedirects) {
      callback(new Error('重定向次數過多'));
      return;
    }

    const parsedUrl = new URL(currentUrl);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;
    
    console.log(`下載嘗試 ${redirectCount + 1}: ${currentUrl}`);
    
    const request = protocol.get(currentUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'audio/mpeg, audio/mp3, audio/mp4, audio/*, */*',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive'
        // 注意：不設置 Range header，確保完整下載
      },
      timeout: 120000 // 增加到 2 分鐘
    }, (response) => {
      console.log(`響應狀態: ${response.statusCode}`);
      console.log(`Content-Type: ${response.headers['content-type'] || '未設置'}`);
      console.log(`Content-Length: ${response.headers['content-length'] || '未知'}`);
      
      // 處理重定向
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        let redirectUrl = response.headers.location;
        // 支援相對位置重新導向
        if (redirectUrl && !/^https?:\/\//i.test(redirectUrl)) {
          redirectUrl = new URL(redirectUrl, currentUrl).toString();
        }
        console.log(`重定向到: ${redirectUrl}`);
        downloadWithRedirect(redirectUrl, redirectCount + 1);
        return;
      }
      
      if (response.statusCode !== 200) {
        callback(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
        return;
      }
      
      const chunks = [];
      let totalLength = 0;
      
      response.on('data', (chunk) => {
        chunks.push(chunk);
        totalLength += chunk.length;
        
        // 減少日誌頻率：每 5MB 輸出一次進度
        if (totalLength % (5 * 1024 * 1024) < chunk.length) {
          console.log(`已下載: ${(totalLength / 1024 / 1024).toFixed(2)}MB`);
        }
      });
      
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        console.log(`下載完成，總大小: ${(buffer.length / 1024 / 1024).toFixed(2)}MB`);
        callback(null, buffer);
      });
      
      response.on('error', (error) => {
        console.error('響應錯誤:', error);
        callback(error);
      });
    });
    
    request.on('error', (error) => {
      console.error('請求錯誤:', error);
      callback(error);
    });
    
    request.on('timeout', () => {
      request.destroy();
      callback(new Error('下載超時'));
    });
  }
  
  downloadWithRedirect(url);
}

function formatTranscript(transcription) {
  if (transcription.segments && transcription.segments.length > 0) {
    return transcription.segments
      .map(segment => {
        const startTime = formatTime(segment.start);
        const endTime = formatTime(segment.end);
        return `[${startTime} - ${endTime}] ${segment.text.trim()}`;
      })
      .join('\n\n');
  } else {
    return transcription.text || '';
  }
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
}

// 音檔壓縮功能 - 增強版，支持多種編解碼器
function compressAudio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const compressStartTime = Date.now();
    console.log(`\n  🗜️ 開始壓縮音檔`);
    console.log(`    輸入檔案: ${path.basename(inputPath)}`);
    logMemoryUsage('壓縮開始');
    
    // 嘗試不同的編解碼器配置（優化：使用 48k 比特率以加快壓縮速度）
    const codecConfigs = [
      // 配置 1: 嘗試 libmp3lame (最佳)
      {
        codec: 'libmp3lame',
        format: 'mp3',
        ext: '.mp3',
        bitrate: '48k'  // 優化：降低比特率以加快壓縮
      },
      // 配置 2: 嘗試 mp3 (備用)
      {
        codec: 'mp3',
        format: 'mp3', 
        ext: '.mp3',
        bitrate: '48k'  // 優化：降低比特率以加快壓縮
      },
      // 配置 3: 使用 AAC (通用支持)
      {
        codec: 'aac',
        format: 'mp4',
        ext: '.m4a',
        bitrate: '48k'  // 優化：降低比特率以加快壓縮
      },
      // 配置 4: 使用 libvorbis + ogg (開源)
      {
        codec: 'libvorbis',
        format: 'ogg',
        ext: '.ogg',
        bitrate: '48k'  // 優化：降低比特率以加快壓縮
      },
      // 配置 5: 最基本的 PCM 重採樣 (總是可用)
      {
        codec: 'pcm_s16le',
        format: 'wav',
        ext: '.wav',
        bitrate: null
      }
    ];

    async function tryCompress(configIndex = 0) {
      if (configIndex >= codecConfigs.length) {
        reject(new Error('所有編解碼器都不可用，無法壓縮音檔'));
        return;
      }

      const config = codecConfigs[configIndex];
      const finalOutputPath = outputPath.replace(/\.[^.]+$/, config.ext);
      
      console.log(`嘗試編解碼器 ${configIndex + 1}/${codecConfigs.length}: ${config.codec} (${config.format})`);

      const command = ffmpeg(inputPath)
        .audioCodec(config.codec)
        .audioFrequency(16000)  // 降低採樣率以減少檔案大小
        .audioChannels(1)       // 單聲道
        .format(config.format);

      // 只有在支持比特率的編解碼器上設置比特率
      if (config.bitrate) {
        command.audioBitrate(config.bitrate);
      }

      command
        .on('start', (commandLine) => {
          console.log(`FFmpeg 命令: ${commandLine}`);
        })
        .on('progress', (progress) => {
          if (progress.percent) {
            console.log(`壓縮進度: ${Math.round(progress.percent)}%`);
          }
        })
        .on('end', () => {
          const compressDuration = ((Date.now() - compressStartTime) / 1000).toFixed(2);
          console.log(`  ✅ 音檔壓縮完成，使用編解碼器: ${config.codec}，耗時: ${compressDuration} 秒`);
          logMemoryUsage('壓縮完成');
          resolve(finalOutputPath);
        })
        .on('error', (err) => {
          console.log(`    ⚠️ 編解碼器 ${config.codec} 失敗: ${err.message}`);
          // 嘗試下一個編解碼器
          tryCompress(configIndex + 1);
        })
        .save(finalOutputPath);
    }

    tryCompress();
  });
}

// 音檔分割功能 - 增強版，支持多種格式
function splitAudio(inputPath, outputDir, segmentDuration = 600) { // 10分鐘片段
  return new Promise((resolve, reject) => {
    const splitStartTime = Date.now();
    console.log(`\n  ✂️ 開始分割音檔`);
    console.log(`    輸入檔案: ${path.basename(inputPath)}`);
    console.log(`    片段長度: ${segmentDuration}秒 (${segmentDuration / 60} 分鐘)`);
    logMemoryUsage('分割開始');
    
    // 創建輸出目錄
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // 根據輸入檔案決定輸出格式
    const inputExt = path.extname(inputPath).toLowerCase();
    let outputExt = '.mp3';
    let audioCodec = 'libmp3lame';
    let audioBitrate = '64k';
    
    // 根據輸入格式選擇最合適的輸出配置
    if (inputExt === '.m4a' || inputExt === '.mp4') {
      outputExt = '.m4a';
      audioCodec = 'aac';
    } else if (inputExt === '.ogg') {
      outputExt = '.ogg';
      audioCodec = 'libvorbis';
    } else if (inputExt === '.wav') {
      outputExt = '.wav';
      audioCodec = 'pcm_s16le';
      audioBitrate = null; // WAV 不需要比特率設置
    }
    
    const outputPattern = path.join(outputDir, `segment_%03d${outputExt}`);
    console.log(`分割輸出格式: ${outputExt}，編解碼器: ${audioCodec}`);
    
    const command = ffmpeg(inputPath)
      .audioCodec(audioCodec)
      .format(outputExt.substring(1)) // 移除點號
      .outputOptions([
        '-f', 'segment',
        '-segment_time', segmentDuration.toString(),
        '-reset_timestamps', '1'
      ]);
    
    // 只在需要時設置比特率
    if (audioBitrate) {
      command.audioBitrate(audioBitrate);
    }
    
    command
      .on('start', (commandLine) => {
        console.log('FFmpeg 分割命令:', commandLine);
      })
      .on('progress', (progress) => {
        if (progress.percent) {
          console.log(`    分割進度: ${Math.round(progress.percent)}%`);
        }
      })
      .on('end', () => {
        // 獲取生成的片段檔案列表
        const files = fs.readdirSync(outputDir)
          .filter(file => file.startsWith('segment_') && file.endsWith(outputExt))
          .sort()
          .map(file => path.join(outputDir, file));
        
        const splitDuration = ((Date.now() - splitStartTime) / 1000).toFixed(2);
        console.log(`  ✅ 音檔分割完成，共 ${files.length} 個片段，耗時: ${splitDuration} 秒`);
        logMemoryUsage('分割完成');
        resolve(files);
      })
      .on('error', (err) => {
        console.error(`  ❌ 音檔分割失敗: ${err.message}`);
        console.error(`  錯誤詳情:`, err);
        logMemoryUsage('分割失敗');
        reject(err);
      })
      .save(outputPattern);
  });
}

// 處理大音檔的主要函數
async function processLargeAudio(audioFile, title) {
  const tempDir = path.join(__dirname, 'temp');
  const timestamp = Date.now();
  const baseFilename = `audio_${timestamp}`;
  
  // 確保臨時目錄存在
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  
  const compressedPath = path.join(tempDir, `${baseFilename}_compressed.mp3`);
  
  try {
    // 步驟 1: 嘗試壓縮音檔
    console.log('  步驟 1/2: 壓縮音檔以減少檔案大小...');
    const actualCompressedPath = await compressAudio(audioFile.filepath, compressedPath);
    
    // 檢查壓縮後的檔案大小
    const compressedStats = fs.statSync(actualCompressedPath);
    const compressedSizeMB = compressedStats.size / 1024 / 1024;
    console.log(`壓縮後檔案大小: ${compressedSizeMB.toFixed(2)}MB`);
    console.log(`使用的檔案格式: ${path.extname(actualCompressedPath)}`);
    
    // 新增：驗證壓縮後的檔案
    try {
      console.log('驗證壓縮後的音檔格式...');
      const validatedCompressedPath = validateAndNormalizeAudioFile(actualCompressedPath);
      validateAudioFileContent(validatedCompressedPath);
      console.log('✅ 壓縮後音檔格式驗證通過');
    } catch (validationError) {
      console.error('壓縮後音檔驗證失敗:', validationError);
      throw new Error(`壓縮後音檔格式無效: ${validationError.message}`);
    }
    
    const OPENAI_LIMIT = 25 * 1024 * 1024;
    
    if (compressedStats.size <= OPENAI_LIMIT) {
      // 壓縮後符合限制，直接返回壓縮檔案
      console.log('✅ 壓縮後符合 25MB 限制，可直接轉錄');
      return {
        type: 'single',
        file: actualCompressedPath,
        size: compressedStats.size
      };
    }
    
    // 步驟 2: 壓縮後還是太大，需要分割
    console.log('  步驟 2/2: 壓縮後仍超過限制，開始分割音檔...');
    const segmentDir = path.join(tempDir, `${baseFilename}_segments`);
    const segmentFiles = await splitAudio(actualCompressedPath, segmentDir, 300); // 5分鐘片段（優化：更小的片段處理更快）
    
    // 新增：驗證所有分割片段
    console.log('驗證分割片段格式...');
    const validatedSegmentFiles = [];
    for (let i = 0; i < segmentFiles.length; i++) {
      const segmentFile = segmentFiles[i];
      try {
        console.log(`驗證片段 ${i + 1}/${segmentFiles.length}: ${path.basename(segmentFile)}`);
        const validatedSegmentPath = validateAndNormalizeAudioFile(segmentFile);
        validateAudioFileContent(validatedSegmentPath);
        validatedSegmentFiles.push(validatedSegmentPath);
        console.log(`✅ 片段 ${i + 1} 驗證通過`);
      } catch (validationError) {
        console.error(`片段 ${i + 1} 驗證失敗:`, validationError);
        throw new Error(`分割片段 ${i + 1} 格式無效: ${validationError.message}`);
      }
    }
    
    console.log(`✅ 音檔處理完成，共 ${validatedSegmentFiles.length} 個片段`);
    return {
      type: 'segments',
      files: validatedSegmentFiles,
      totalSegments: validatedSegmentFiles.length,
      file: actualCompressedPath // 保存壓縮檔案路徑用於清理
    };
    
  } catch (error) {
    console.error('\n❌ 音檔處理過程發生錯誤');
    console.error('錯誤類型:', error.constructor.name);
    console.error('錯誤訊息:', error.message);
    console.error('錯誤堆疊:', error.stack);
    logMemoryUsage('處理錯誤');
    
    // 清理臨時檔案
    console.log('\n🧹 開始清理臨時檔案...');
    try {
      // 清理壓縮檔案
      const possibleExtensions = ['.mp3', '.m4a', '.ogg', '.wav'];
      const basePath = compressedPath.replace(/\.[^.]+$/, '');
      
      for (const ext of possibleExtensions) {
        const possiblePath = basePath + ext;
        if (fs.existsSync(possiblePath)) {
          fs.unlinkSync(possiblePath);
          console.log(`  ✅ 清理了臨時檔案: ${path.basename(possiblePath)}`);
        }
      }
      
      // 清理分割片段目錄
      const segmentDir = path.join(tempDir, `${baseFilename}_segments`);
      if (fs.existsSync(segmentDir)) {
        const segmentFiles = fs.readdirSync(segmentDir);
        for (const file of segmentFiles) {
          const filePath = path.join(segmentDir, file);
          try {
            fs.unlinkSync(filePath);
            console.log(`  ✅ 清理了片段檔案: ${file}`);
          } catch (fileError) {
            console.warn(`  ⚠️ 無法清理片段檔案 ${file}:`, fileError.message);
          }
        }
        try {
          fs.rmdirSync(segmentDir);
          console.log(`  ✅ 清理了片段目錄`);
        } catch (dirError) {
          console.warn(`  ⚠️ 無法清理片段目錄:`, dirError.message);
        }
      }
      
      console.log('✅ 臨時檔案清理完成');
    } catch (cleanupError) {
      console.error('❌ 清理臨時檔案失敗:', cleanupError);
      console.error('清理錯誤堆疊:', cleanupError.stack);
    }
    
    throw new Error(`音檔處理失敗: ${error.message}`);
  }
}

// 增量合併轉錄結果（避免記憶體累積）
function mergeTranscriptionIncremental(currentResult, newTranscription, segmentIndex, totalSegments) {
  let mergedText = currentResult.text || '';
  let totalDuration = currentResult.duration || 0;
  let allSegments = currentResult.segments || [];
  
  // 添加片段標識（僅在多片段時）
  if (totalSegments > 1) {
    mergedText += `\n=== 片段 ${segmentIndex} ===\n`;
  }
  
  if (newTranscription.segments && newTranscription.segments.length > 0) {
    // 調整時間戳（加上前面片段的總時長）
    const adjustedSegments = newTranscription.segments.map(segment => ({
      ...segment,
      start: segment.start + totalDuration,
      end: segment.end + totalDuration
    }));
    
    allSegments = allSegments.concat(adjustedSegments);
    
    // 生成文字
    const segmentText = adjustedSegments
      .map(segment => {
        const startTime = formatTime(segment.start);
        const endTime = formatTime(segment.end);
        return `[${startTime} - ${endTime}] ${segment.text.trim()}`;
      })
      .join('\n\n');
    mergedText += segmentText;
  } else {
    // 沒有 segments，使用 text
    if (newTranscription.text) {
      mergedText += newTranscription.text;
    }
  }
  
  mergedText += '\n\n';
  totalDuration += newTranscription.duration || 0;
  
  return {
    text: mergedText,
    duration: totalDuration,
    segments: allSegments,
    totalSegments: segmentIndex
  };
}

// 增量合併轉錄結果（使用固定偏移量，確保時間戳準確）
function mergeTranscriptionIncrementalWithOffset(currentResult, newTranscription, segmentIndex, totalSegments, segmentOffset, segmentDuration) {
  let mergedText = currentResult.text || '';
  let allSegments = currentResult.segments || [];
  
  // 添加片段標識（僅在多片段時）
  if (totalSegments > 1) {
    mergedText += `\n=== 片段 ${segmentIndex} ===\n`;
  }
  
  if (newTranscription.segments && newTranscription.segments.length > 0) {
    // 調整時間戳（使用固定偏移量）
    const adjustedSegments = newTranscription.segments.map(segment => ({
      ...segment,
      start: Math.max(0, segment.start) + segmentOffset,
      end: Math.max(0, segment.end) + segmentOffset
    }));
    
    allSegments = allSegments.concat(adjustedSegments);
    
    // 生成文字
    const segmentText = adjustedSegments
      .map(segment => {
        const startTime = formatTime(segment.start);
        const endTime = formatTime(segment.end);
        return `[${startTime} - ${endTime}] ${segment.text.trim()}`;
      })
      .join('\n\n');
    mergedText += segmentText;
  } else {
    // 沒有 segments，使用 text
    if (newTranscription.text) {
      mergedText += newTranscription.text;
    }
  }
  
  mergedText += '\n\n';
  
  return {
    text: mergedText,
    duration: currentResult.duration || 0, // 將由調用者更新
    segments: allSegments,
    totalSegments: segmentIndex
  };
}

// 合併多個轉錄結果（保留用於向後兼容）- 使用固定偏移量修正時間戳
function mergeTranscriptions(transcriptions) {
  let mergedText = '';
  let allSegments = [];
  const SEGMENT_DURATION = 300; // 固定片段時長：5 分鐘
  
  transcriptions.forEach((transcription, index) => {
    // 使用固定偏移量（基於片段索引）而不是累加的 duration
    const segmentOffset = index * SEGMENT_DURATION;
    
    if (transcription.segments && transcription.segments.length > 0) {
      // 調整時間戳：使用固定的片段偏移量
      const adjustedSegments = transcription.segments.map(segment => {
        const adjustedStart = Math.max(0, segment.start) + segmentOffset;
        const adjustedEnd = Math.max(0, segment.end) + segmentOffset;
        
        return {
          ...segment,
          start: adjustedStart,
          end: adjustedEnd
        };
      });
      
      allSegments = allSegments.concat(adjustedSegments);
    }
    
    // 添加片段標識
    if (transcriptions.length > 1) {
      mergedText += `\n=== 片段 ${index + 1} (偏移: ${formatTime(segmentOffset)}) ===\n`;
    }
    
    if (transcription.segments && transcription.segments.length > 0) {
      const segmentText = transcription.segments
        .map(segment => {
          // 使用固定偏移量
          const adjustedStart = Math.max(0, segment.start) + segmentOffset;
          const adjustedEnd = Math.max(0, segment.end) + segmentOffset;
          const startTime = formatTime(adjustedStart);
          const endTime = formatTime(adjustedEnd);
          return `[${startTime} - ${endTime}] ${segment.text.trim()}`;
        })
        .join('\n\n');
      mergedText += segmentText;
    } else {
      mergedText += transcription.text || '';
    }
    
    mergedText += '\n\n';
  });
  
  // 計算總時長：最後一個片段的偏移量 + 最後一個片段的實際時長
  const lastTranscription = transcriptions[transcriptions.length - 1];
  const lastSegmentOffset = (transcriptions.length - 1) * SEGMENT_DURATION;
  const lastSegmentDuration = lastTranscription?.duration || SEGMENT_DURATION;
  const totalDuration = lastSegmentOffset + lastSegmentDuration;
  
  return {
    text: mergedText.trim(),
    duration: totalDuration,
    segments: allSegments,
    totalSegments: transcriptions.length
  };
}

// 啟動服務器
// 靜態文件服務（生產環境）- 必須在 app.listen() 之前設置
if (process.env.NODE_ENV === 'production' || !process.env.NODE_ENV) {
  // 檢查 build 目錄是否存在
  const buildPath = path.join(__dirname, 'build');
  if (fs.existsSync(buildPath)) {
    app.use(express.static(buildPath));
  
    // 所有其他路由都返回 index.html（用於 React Router）
  app.get('*', (req, res) => {
      res.sendFile(path.join(buildPath, 'index.html'));
    });
    console.log('✅ 靜態檔案服務已啟用，build 目錄:', buildPath);
  } else {
    console.warn('⚠️ build 目錄不存在，靜態檔案服務未啟用。請先執行 npm run build');
  }
}

app.listen(PORT, () => {
  console.log(`服務器運行在端口 ${PORT}`);
  console.log(`環境: ${process.env.NODE_ENV || 'development'}`);
  console.log(`OpenAI API Key: ${process.env.OPENAI_API_KEY ? '已設置' : '未設置'}`);
}); 