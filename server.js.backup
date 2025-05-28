const express = require('express');
const path = require('path');
const formidable = require('formidable');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// 初始化 OpenAI 客戶端
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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
  console.log(`=== 測試 API 請求 ===`);
  console.log(`方法: ${req.method}`);
  console.log(`URL: ${req.url}`);
  
  res.json({
    success: true,
    message: 'API 測試成功！',
    method: req.method,
    url: req.url,
    timestamp: new Date().toISOString(),
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      env: {
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ? '已設置' : '未設置',
        PORT: process.env.PORT || '未設置'
      }
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
      return res.status(500).json({ 
        error: `音檔下載失敗: ${error.message}` 
      });
    }

    console.log(`音檔下載完成，大小: ${(audioBuffer.length / 1024 / 1024).toFixed(2)}MB`);

    // 檢查下載的內容是否為有效音檔
    if (audioBuffer.length < 1024) {
      return res.status(500).json({ 
        error: '下載的檔案太小，可能不是有效的音檔' 
      });
    }

    // 設置響應 headers
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audioBuffer.length);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(title || 'audio')}.mp3"`);
    
    // 返回音檔數據
    res.send(audioBuffer);
  });
});

// 轉錄 API
app.post('/api/transcribe', (req, res) => {
  console.log(`=== API 請求開始 ===`);
  console.log(`方法: ${req.method}`);
  console.log(`URL: ${req.url}`);
  
  const form = formidable({
    maxFileSize: 25 * 1024 * 1024, // 25MB 限制
    keepExtensions: true,
  });

  console.log('開始解析表單數據...');
  
  form.parse(req, (err, fields, files) => {
    if (err) {
      console.error('表單解析錯誤:', err);
      return res.status(400).json({ error: `表單解析失敗: ${err.message}` });
    }

    console.log('表單解析完成');
    
    const audioFile = files.audio?.[0];
    const title = fields.title?.[0] || 'Unknown';
    const episodeId = fields.episodeId?.[0] || 'unknown';

    if (!audioFile) {
      console.log('沒有找到音檔');
      return res.status(400).json({ error: '沒有找到音檔' });
    }

    console.log(`開始轉錄: ${title} (${episodeId})`);
    console.log(`檔案路徑: ${audioFile.filepath}`);
    console.log(`檔案大小: ${(audioFile.size / 1024 / 1024).toFixed(2)}MB`);

    // 檢查 OpenAI API 金鑰
    if (!process.env.OPENAI_API_KEY) {
      console.error('OpenAI API 金鑰未設置');
      return res.status(500).json({ 
        error: 'OpenAI API 金鑰未設置' 
      });
    }

    console.log('開始調用 OpenAI Whisper API...');
    const startTime = Date.now();
    
    // 使用 OpenAI Whisper API 進行轉錄
    openai.audio.transcriptions.create({
      file: fs.createReadStream(audioFile.filepath),
      model: 'whisper-1',
      language: 'zh',
      response_format: 'verbose_json',
      timestamp_granularities: ['word'],
    })
    .then(transcription => {
      const endTime = Date.now();
      console.log(`OpenAI API 調用成功，耗時: ${(endTime - startTime) / 1000}秒`);

      // 清理臨時檔案
      try {
        fs.unlinkSync(audioFile.filepath);
        console.log('臨時檔案清理成功');
      } catch (cleanupError) {
        console.warn('清理臨時檔案失敗:', cleanupError);
      }

      // 格式化逐字稿文字
      const formattedText = formatTranscript(transcription);

      console.log(`轉錄完成: ${title}`);
      console.log(`文字長度: ${formattedText.length} 字元`);

      // 回傳結果
      res.json({
        success: true,
        episodeId,
        title,
        text: formattedText,
        duration: transcription.duration,
        language: transcription.language,
        segments: transcription.segments || [],
        url: null,
      });
    })
    .catch(error => {
      console.error('=== 轉錄錯誤 ===');
      console.error('錯誤詳情:', error);
      
      // 清理臨時檔案
      try {
        fs.unlinkSync(audioFile.filepath);
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
    });
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
      timeout: 30000
    }, (response) => {
      console.log(`響應狀態: ${response.statusCode}`);
      
      // 處理重定向
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const redirectUrl = response.headers.location;
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
        
        // 每 1MB 輸出一次進度
        if (totalLength % (1024 * 1024) < chunk.length) {
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

// 啟動服務器
app.listen(PORT, () => {
  console.log(`服務器運行在端口 ${PORT}`);
  console.log(`環境: ${process.env.NODE_ENV || 'development'}`);
  console.log(`OpenAI API Key: ${process.env.OPENAI_API_KEY ? '已設置' : '未設置'}`);
}); 