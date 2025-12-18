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

const app = express();
const PORT = process.env.PORT || 3000;

// 設置 Express server timeout（30 分鐘，足夠處理長音檔）
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

// 增強版轉錄 API
app.post('/api/transcribe', (req, res) => {
  const requestStartTime = Date.now();
  console.log(`\n=== 增強版轉錄 API 請求開始 ===`);
  console.log(`請求時間: ${new Date().toISOString()}`);
  logMemoryUsage('請求開始');
  
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
    maxFileSize: 30 * 1024 * 1024, // 30MB 上傳上限，稍高於 OpenAI 25MB 限制
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
      return res.status(400).json({ error: `表單解析失敗: ${err.message}` });
    }
    
    const audioFile = files.audio?.[0];
    const title = fields.title?.[0] || 'Unknown';
    const episodeId = fields.episodeId?.[0] || 'unknown';
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
      console.log('沒有找到音檔');
      return res.status(400).json({ error: '沒有找到音檔' });
    }

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
      
      // 生成優化的提示詞
      let optimizedPrompt = TranscriptionOptimizer.generateOptimizedPrompt('zh', contentType);
      
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
            const basePrompt = TranscriptionOptimizer.generateOptimizedPrompt('zh', contentType);
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
      
      if (processedAudio.type === 'single') {
        // 單一檔案轉錄
        console.log('  轉錄模式: 單一檔案');
        const segmentStartTime = Date.now();
        addTranscriptionLog(episodeId, 'info', '轉錄模式: 單一檔案', '轉錄');
        // 嘗試使用 gpt-4o-transcribe，如果失敗則回退到 whisper-1
        let transcription;
        try {
          console.log('  正在呼叫 OpenAI API...');
          addTranscriptionLog(episodeId, 'info', '正在呼叫 OpenAI API...', '轉錄');
          transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(processedAudio.file),
            model: 'gpt-4o-transcribe', // 嘗試使用新模型
            language: 'zh',
            response_format: 'verbose_json',
            timestamp_granularities: ['word'],
            prompt: optimizedPrompt
          });
          const segmentDuration = ((Date.now() - segmentStartTime) / 1000).toFixed(2);
          console.log(`  ✅ 使用 gpt-4o-transcribe 模型轉錄成功，耗時: ${segmentDuration} 秒`);
          addTranscriptionLog(episodeId, 'success', `使用 gpt-4o-transcribe 模型轉錄成功，耗時: ${segmentDuration} 秒`, '轉錄');
        } catch (modelError) {
          console.warn(`  ⚠️ gpt-4o-transcribe 不可用，回退到 whisper-1: ${modelError.message}`);
          console.log('  正在使用 whisper-1 模型...');
          addTranscriptionLog(episodeId, 'warn', `gpt-4o-transcribe 不可用，回退到 whisper-1`, '轉錄');
          transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(processedAudio.file),
            model: 'whisper-1', // 回退到原模型
            language: 'zh',
            response_format: 'verbose_json',
            timestamp_granularities: ['word'],
            prompt: optimizedPrompt
          });
        }
        
        finalTranscription = transcription;
        
      } else {
        // 多片段轉錄
        console.log(`  轉錄模式: 多片段（共 ${processedAudio.totalSegments} 個片段）`);
        const transcriptions = [];
        const totalSegments = processedAudio.files.length;
        
        for (let i = 0; i < processedAudio.files.length; i++) {
          const segmentFile = processedAudio.files[i];
          const segmentStartTime = Date.now();
          console.log(`\n  📝 片段 ${i + 1}/${totalSegments}: ${path.basename(segmentFile)}`);
          logMemoryUsage(`片段 ${i + 1} 開始`);
          addTranscriptionLog(episodeId, 'info', `片段 ${i + 1}/${totalSegments}: ${path.basename(segmentFile)}`, '轉錄');
          
          // 嘗試使用 gpt-4o-transcribe，如果失敗則回退到 whisper-1
          let transcription;
          try {
            console.log(`    正在呼叫 OpenAI API...`);
            addTranscriptionLog(episodeId, 'info', `片段 ${i + 1} 正在呼叫 OpenAI API...`, '轉錄');
            transcription = await openai.audio.transcriptions.create({
              file: fs.createReadStream(segmentFile),
              model: 'gpt-4o-transcribe', // 嘗試使用新模型
              language: 'zh',
              response_format: 'verbose_json',
              timestamp_granularities: ['word'],
              prompt: optimizedPrompt
            });
          } catch (modelError) {
            console.warn(`    ⚠️ gpt-4o-transcribe 不可用，回退到 whisper-1: ${modelError.message}`);
            console.log(`    正在使用 whisper-1 模型...`);
            transcription = await openai.audio.transcriptions.create({
              file: fs.createReadStream(segmentFile),
              model: 'whisper-1', // 回退到原模型
              language: 'zh',
              response_format: 'verbose_json',
              timestamp_granularities: ['word'],
              prompt: optimizedPrompt
            });
          }
          
          transcriptions.push(transcription);
          const segmentDuration = ((Date.now() - segmentStartTime) / 1000).toFixed(2);
          console.log(`    ✅ 片段 ${i + 1} 轉錄完成，耗時: ${segmentDuration} 秒`);
          logMemoryUsage(`片段 ${i + 1} 完成`);
          addTranscriptionLog(episodeId, 'success', `片段 ${i + 1} 轉錄完成，耗時: ${segmentDuration} 秒`, '轉錄');
          
          // 片段間稍作延遲，避免API請求過快
          if (i < processedAudio.files.length - 1) {
            console.log(`    等待 1 秒後處理下一個片段...`);
            addTranscriptionLog(episodeId, 'info', '等待 1 秒後處理下一個片段...', '轉錄');
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
        
        // 合併所有轉錄結果
        console.log(`\n  🔗 合併 ${transcriptions.length} 個轉錄結果...`);
        const mergeStartTime = Date.now();
        finalTranscription = mergeTranscriptions(transcriptions);
        const mergeDuration = ((Date.now() - mergeStartTime) / 1000).toFixed(2);
        console.log(`  ✅ 合併完成，耗時: ${mergeDuration} 秒`);
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
        'Accept': 'audio/mpeg, audio/*, */*',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive'
      },
      timeout: 120000 // 增加到 2 分鐘
    }, (response) => {
      console.log(`響應狀態: ${response.statusCode}`);
      
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
    
    // 嘗試不同的編解碼器配置
    const codecConfigs = [
      // 配置 1: 嘗試 libmp3lame (最佳)
      {
        codec: 'libmp3lame',
        format: 'mp3',
        ext: '.mp3',
        bitrate: '64k'
      },
      // 配置 2: 嘗試 mp3 (備用)
      {
        codec: 'mp3',
        format: 'mp3', 
        ext: '.mp3',
        bitrate: '64k'
      },
      // 配置 3: 使用 AAC (通用支持)
      {
        codec: 'aac',
        format: 'mp4',
        ext: '.m4a',
        bitrate: '64k'
      },
      // 配置 4: 使用 libvorbis + ogg (開源)
      {
        codec: 'libvorbis',
        format: 'ogg',
        ext: '.ogg',
        bitrate: '64k'
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
    const segmentFiles = await splitAudio(actualCompressedPath, segmentDir, 600); // 10分鐘片段
    
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

// 合併多個轉錄結果
function mergeTranscriptions(transcriptions) {
  let mergedText = '';
  let totalDuration = 0;
  let allSegments = [];
  
  transcriptions.forEach((transcription, index) => {
    if (transcription.segments && transcription.segments.length > 0) {
      // 調整時間戳（加上前面片段的總時長）
      const adjustedSegments = transcription.segments.map(segment => ({
        ...segment,
        start: segment.start + totalDuration,
        end: segment.end + totalDuration
      }));
      
      allSegments = allSegments.concat(adjustedSegments);
    }
    
    // 添加片段標識
    if (transcriptions.length > 1) {
      mergedText += `\n=== 片段 ${index + 1} ===\n`;
    }
    
    if (transcription.segments && transcription.segments.length > 0) {
      const segmentText = transcription.segments
        .map(segment => {
          const startTime = formatTime(segment.start + totalDuration);
          const endTime = formatTime(segment.end + totalDuration);
          return `[${startTime} - ${endTime}] ${segment.text.trim()}`;
        })
        .join('\n\n');
      mergedText += segmentText;
    } else {
      mergedText += transcription.text || '';
    }
    
    mergedText += '\n\n';
    totalDuration += transcription.duration || 0;
  });
  
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