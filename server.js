const express = require('express');
const path = require('path');
const formidable = require('formidable');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const OpenAI = require('openai');
const ffmpeg = require('fluent-ffmpeg'); let ffmpegAvailable = true;

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

// 轉錄 API
app.post('/api/transcribe', (req, res) => {
  console.log(`轉錄 API 請求開始`);
  
  const form = new formidable.IncomingForm({
    maxFileSize: 30 * 1024 * 1024, // 30MB 上傳上限，稍高於 OpenAI 25MB 限制
    keepExtensions: true,
  });
  
  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error('表單解析錯誤:', err);
      return res.status(400).json({ error: `表單解析失敗: ${err.message}` });
    }
    
    const audioFile = files.audio?.[0];
    const title = fields.title?.[0] || 'Unknown';
    const episodeId = fields.episodeId?.[0] || 'unknown';

    if (!audioFile) {
      console.log('沒有找到音檔');
      return res.status(400).json({ error: '沒有找到音檔' });
    }

    console.log(`開始轉錄: ${title} (${(audioFile.size / 1024 / 1024).toFixed(2)}MB)`);

    // OpenAI Whisper 限制為 25MB，超出則自動處理
    const OPENAI_LIMIT = 25 * 1024 * 1024;
    let processedAudio;
    
    if (audioFile.size > OPENAI_LIMIT) {
      const fileSizeMB = (audioFile.size / 1024 / 1024).toFixed(2);
      console.log(`音檔大小 ${fileSizeMB}MB 超過 25MB，啟動自動處理...`);
      
      try {
        // 使用音檔處理功能（壓縮/分割）
        try { processedAudio = await processLargeAudio(audioFile, title); } catch (ffmpegError) { if (ffmpegError.message.includes("ffmpeg") || ffmpegError.message.includes("ENOENT")) { console.error("FFmpeg 不可用:", ffmpegError.message); return res.status(413).json({ error: "音檔大小超過限制，且伺服器音檔處理功能不可用", message: "請手動壓縮音檔", suggestions: ["使用音訊編輯軟體壓縮至25MB以下", "降低音質至128kbps或更低", "分割成較短片段", "轉換為MP3格式"], currentSize: fileSizeMB + "MB", maxSize: "25MB" }); } throw ffmpegError; }
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
      
      if (processedAudio.type === 'single') {
        // 單一檔案轉錄
        console.log('開始轉錄單一音檔...');
        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream(processedAudio.file),
          model: 'whisper-1',
          language: 'zh',
          response_format: 'verbose_json',
          timestamp_granularities: ['word'],
          prompt: '請使用繁體中文進行轉錄。'
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
            prompt: '請使用繁體中文進行轉錄。'
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

      // 格式化逐字稿文字
      const formattedText = finalTranscription.segments && finalTranscription.segments.length > 0
        ? formatTranscript(finalTranscription)
        : finalTranscription.text || '';

      console.log(`轉錄完成: ${title}`);
      console.log(`文字長度: ${formattedText.length} 字元`);
      if (processedAudio.type === 'segments') {
        console.log(`共處理 ${processedAudio.totalSegments} 個音檔片段`);
      }

      // 回傳結果
      res.json({
        success: true,
        episodeId,
        title,
        text: formattedText,
        duration: finalTranscription.duration,
        language: finalTranscription.language,
        segments: finalTranscription.segments || [],
        url: null,
        processed: processedAudio.type !== 'single',
        totalSegments: processedAudio.type === 'segments' ? processedAudio.totalSegments : 1
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

// 靜態文件服務（生產環境）
if (process.env.NODE_ENV === 'production' || !process.env.NODE_ENV) {
  app.use(express.static(path.join(__dirname, 'build')));
  
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'build', 'index.html'));
  });
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

// 音檔壓縮功能
function compressAudio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    console.log(`開始壓縮音檔: ${inputPath}`);
    
    ffmpeg(inputPath)
      .audioCodec('mp3')
      .audioBitrate('128k')
      .audioFrequency(22050)
      .audioChannels(1)
      .format('mp3')
      .on('start', (commandLine) => {
        console.log('FFmpeg 命令:', commandLine);
      })
      .on('progress', (progress) => {
        if (progress.percent) {
          console.log(`壓縮進度: ${Math.round(progress.percent)}%`);
        }
      })
      .on('end', () => {
        console.log('音檔壓縮完成');
        resolve(outputPath);
      })
      .on('error', (err) => {
        console.error('音檔壓縮失敗:', err);
        reject(err);
      })
      .save(outputPath);
  });
}

// 音檔分割功能
function splitAudio(inputPath, outputDir, segmentDuration = 600) { // 10分鐘片段
  return new Promise((resolve, reject) => {
    console.log(`開始分割音檔: ${inputPath}，片段長度: ${segmentDuration}秒`);
    
    // 創建輸出目錄
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    const outputPattern = path.join(outputDir, 'segment_%03d.mp3');
    
    ffmpeg(inputPath)
      .audioCodec('mp3')
      .audioBitrate('128k')
      .format('mp3')
      .outputOptions([
        '-f', 'segment',
        '-segment_time', segmentDuration.toString(),
        '-reset_timestamps', '1'
      ])
      .on('start', (commandLine) => {
        console.log('FFmpeg 分割命令:', commandLine);
      })
      .on('end', () => {
        // 獲取生成的片段檔案列表
        const files = fs.readdirSync(outputDir)
          .filter(file => file.startsWith('segment_') && file.endsWith('.mp3'))
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
    await compressAudio(audioFile.filepath, compressedPath);
    
    // 檢查壓縮後的檔案大小
    const compressedStats = fs.statSync(compressedPath);
    const compressedSizeMB = compressedStats.size / 1024 / 1024;
    console.log(`壓縮後檔案大小: ${compressedSizeMB.toFixed(2)}MB`);
    
    const OPENAI_LIMIT = 25 * 1024 * 1024;
    
    if (compressedStats.size <= OPENAI_LIMIT) {
      // 壓縮後符合限制，直接返回壓縮檔案
      console.log('✅ 壓縮後符合 25MB 限制，可直接轉錄');
      return {
        type: 'single',
        file: compressedPath,
        size: compressedStats.size
      };
    }
    
    // 步驟 2: 壓縮後還是太大，需要分割
    console.log('步驟 2: 壓縮後仍超過限制，開始分割音檔...');
    const segmentDir = path.join(tempDir, `${baseFilename}_segments`);
    const segmentFiles = await splitAudio(compressedPath, segmentDir, 600); // 10分鐘片段
    
    console.log(`✅ 音檔處理完成，共 ${segmentFiles.length} 個片段`);
    return {
      type: 'segments',
      files: segmentFiles,
      totalSegments: segmentFiles.length
    };
    
  } catch (error) {
    // 清理臨時檔案
    try {
      if (fs.existsSync(compressedPath)) {
        fs.unlinkSync(compressedPath);
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