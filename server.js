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

const app = express();
const PORT = process.env.PORT || 3000;

// 初始化 OpenAI 客戶端，強制使用官方端點避免代理問題
let openai = null;
if (process.env.OPENAI_API_KEY) {
  try {
    // 強制使用官方 OpenAI API 端點，避免代理認證問題
    const baseURL = 'https://api.openai.com/v1';
    
    openai = new OpenAI({ 
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: baseURL,
      timeout: 60000, // 60 秒超時
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
      timeout: 60000,
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

// 增強版轉錄 API
app.post('/api/transcribe', (req, res) => {
  console.log(`增強版轉錄 API 請求開始`);
  
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

    if (!audioFile) {
      console.log('沒有找到音檔');
      return res.status(400).json({ error: '沒有找到音檔' });
    }

    console.log(`開始增強轉錄: ${title} (${(audioFile.size / 1024 / 1024).toFixed(2)}MB)`);
    console.log(`輸出格式: ${outputFormats.join(', ')}`);
    console.log(`內容類型: ${contentType}`);
    console.log(`說話者分離: ${enableSpeakerDiarization ? '啟用' : '停用'}`);

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
      console.log(`音檔大小 ${fileSizeMB}MB 超過 25MB，啟動自動處理...`);
      
      try {
        try { 
          processedAudio = await processLargeAudio(audioFile, title); 
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
        console.log(`音檔處理完成，類型: ${processedAudio.type}`);
      } catch (error) {
        console.error('音檔處理失敗:', error);
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

    console.log(`調用 Whisper API: ${openai.baseURL}`);
    const startTime = Date.now();
    
    try {
      let finalTranscription;
      
      // 生成優化的提示詞
      const optimizedPrompt = TranscriptionOptimizer.generateOptimizedPrompt('zh', contentType);
      console.log(`使用優化提示詞: ${optimizedPrompt}`);
      
      if (processedAudio.type === 'single') {
        // 單一檔案轉錄
        console.log('開始轉錄單一音檔...');
        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream(processedAudio.file),
          model: 'whisper-1',
          language: 'zh',
          response_format: 'verbose_json',
          timestamp_granularities: ['word'],
          prompt: optimizedPrompt
        });
        
        finalTranscription = transcription;
        
      } else {
        // 多片段轉錄
        console.log(`開始轉錄 ${processedAudio.totalSegments} 個音檔片段...`);
        const transcriptions = [];
        
        for (let i = 0; i < processedAudio.files.length; i++) {
          const segmentFile = processedAudio.files[i];
          console.log(`轉錄片段 ${i + 1}/${processedAudio.files.length}: ${path.basename(segmentFile)}`);
          
          const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(segmentFile),
            model: 'whisper-1',
            language: 'zh',
            response_format: 'verbose_json',
            timestamp_granularities: ['word'],
            prompt: optimizedPrompt
          });
          
          transcriptions.push(transcription);
          
          // 片段間稍作延遲，避免API請求過快
          if (i < processedAudio.files.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
        
        // 合併所有轉錄結果
        console.log('合併轉錄結果...');
        finalTranscription = mergeTranscriptions(transcriptions);
      }
      
      const endTime = Date.now();
      console.log(`OpenAI API 調用成功，耗時: ${(endTime - startTime) / 1000}秒`);

      // 處理說話者分離
      if (enableSpeakerDiarization && finalTranscription.segments) {
        console.log('開始處理說話者分離...');
        finalTranscription.segments = await SpeakerDiarization.simulateSpeakerDetection(finalTranscription.segments);
      }

      // 使用增強轉錄處理器生成多種格式
      console.log('生成多種輸出格式...');
      const processedResult = TranscriptionProcessor.processTranscriptionResult(finalTranscription, {
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

      console.log(`轉錄完成: ${title}`);
      console.log(`文字長度: ${processedResult.formats.txt?.length || 0} 字元`);
      if (processedAudio.type === 'segments') {
        console.log(`共處理 ${processedAudio.totalSegments} 個音檔片段`);
      }

      // 回傳增強的結果
      res.json({
        success: true,
        episodeId,
        title,
        text: processedResult.formats.txt || '',
        duration: finalTranscription.duration,
        language: finalTranscription.language,
        segments: finalTranscription.segments || [],
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
    console.log(`開始壓縮音檔: ${inputPath}`);
    
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
          console.log(`音檔壓縮完成，使用編解碼器: ${config.codec}`);
          resolve(finalOutputPath);
        })
        .on('error', (err) => {
          console.log(`編解碼器 ${config.codec} 失敗: ${err.message}`);
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
    console.log(`開始分割音檔: ${inputPath}，片段長度: ${segmentDuration}秒`);
    
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
      .on('end', () => {
        // 獲取生成的片段檔案列表
        const files = fs.readdirSync(outputDir)
          .filter(file => file.startsWith('segment_') && file.endsWith(outputExt))
          .sort()
          .map(file => path.join(outputDir, file));
        
        console.log(`音檔分割完成，共 ${files.length} 個片段`);
        resolve(files);
      })
      .on('error', (err) => {
        console.error('音檔分割失敗:', err);
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
    console.log('步驟 1: 壓縮音檔以減少檔案大小...');
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
    console.log('步驟 2: 壓縮後仍超過限制，開始分割音檔...');
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
    // 清理臨時檔案
    try {
      // 嘗試清理可能的檔案格式
      const possibleExtensions = ['.mp3', '.m4a', '.ogg', '.wav'];
      const basePath = compressedPath.replace(/\.[^.]+$/, '');
      
      for (const ext of possibleExtensions) {
        const possiblePath = basePath + ext;
        if (fs.existsSync(possiblePath)) {
          fs.unlinkSync(possiblePath);
          console.log(`清理了臨時檔案: ${possiblePath}`);
        }
      }
    } catch (cleanupError) {
      console.warn('清理臨時檔案失敗:', cleanupError);
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
app.listen(PORT, () => {
  console.log(`服務器運行在端口 ${PORT}`);
  console.log(`環境: ${process.env.NODE_ENV || 'development'}`);
  console.log(`OpenAI API Key: ${process.env.OPENAI_API_KEY ? '已設置' : '未設置'}`);
});

// 靜態文件服務（生產環境）
if (process.env.NODE_ENV === 'production' || !process.env.NODE_ENV) {
  app.use(express.static(path.join(__dirname, 'build')));
  
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'build', 'index.html'));
  });
} 