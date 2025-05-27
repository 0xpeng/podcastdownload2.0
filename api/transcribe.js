// @vercel/node
const formidable = require('formidable');
const fs = require('fs');
const OpenAI = require('openai');

// 初始化 OpenAI 客戶端
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 主要處理函數
function handler(req, res) {
  console.log(`=== API 請求開始 ===`);
  console.log(`方法: ${req.method}`);
  console.log(`URL: ${req.url}`);
  console.log(`Headers:`, JSON.stringify(req.headers, null, 2));
  console.log(`環境變數檢查:`);
  console.log(`- OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? '已設置' : '未設置'}`);
  console.log(`- PASSWORD: ${process.env.PASSWORD ? '已設置' : '未設置'}`);
  console.log(`- PORT: ${process.env.PORT || '未設置'}`);
  
  // 設定 CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    console.log('處理 OPTIONS 請求');
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    console.log(`不支援的方法: ${req.method}`);
    res.status(405).json({ error: `只支援 POST 請求，收到: ${req.method}` });
    return;
  }

  console.log('開始處理轉錄請求...');
  
  // 解析上傳的檔案
  const form = formidable({
    maxFileSize: 25 * 1024 * 1024, // 25MB 限制
    keepExtensions: true,
  });

  console.log('開始解析表單數據...');
  
  form.parse(req, (err, fields, files) => {
    if (err) {
      console.error('表單解析錯誤:', err);
      res.status(400).json({ error: `表單解析失敗: ${err.message}` });
      return;
    }

    console.log('表單解析完成');
    console.log('Fields:', Object.keys(fields));
    console.log('Files:', Object.keys(files));
    
    const audioFile = files.audio?.[0];
    const title = fields.title?.[0] || 'Unknown';
    const episodeId = fields.episodeId?.[0] || 'unknown';

    if (!audioFile) {
      console.log('沒有找到音檔');
      res.status(400).json({ error: '沒有找到音檔' });
      return;
    }

    console.log(`開始轉錄: ${title} (${episodeId})`);
    console.log(`檔案路徑: ${audioFile.filepath}`);
    console.log(`檔案大小: ${(audioFile.size / 1024 / 1024).toFixed(2)}MB`);
    console.log(`檔案類型: ${audioFile.mimetype}`);

    // 檢查檔案大小
    if (audioFile.size > 25 * 1024 * 1024) {
      console.log('音檔太大');
      res.status(400).json({ 
        error: '音檔太大，請確保檔案小於 25MB' 
      });
      return;
    }

    // 檢查 OpenAI API 金鑰
    if (!process.env.OPENAI_API_KEY) {
      console.error('OpenAI API 金鑰未設置');
      res.status(500).json({ 
        error: 'OpenAI API 金鑰未設置' 
      });
      return;
    }

    console.log('開始調用 OpenAI Whisper API...');
    const startTime = Date.now();
    
    // 使用 OpenAI Whisper API 進行轉錄
    openai.audio.transcriptions.create({
      file: fs.createReadStream(audioFile.filepath),
      model: 'whisper-1',
      language: 'zh', // 指定中文
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
      console.log(`=== API 請求結束 ===`);

      // 回傳結果
      res.status(200).json({
        success: true,
        episodeId,
        title,
        text: formattedText,
        duration: transcription.duration,
        language: transcription.language,
        segments: transcription.segments || [],
        url: null, // 可以後續實作檔案儲存
      });
    })
    .catch(error => {
      console.error('=== 轉錄錯誤 ===');
      console.error('錯誤詳情:', error);
      console.error('錯誤堆疊:', error.stack);
      
      // 清理臨時檔案
      try {
        fs.unlinkSync(audioFile.filepath);
        console.log('錯誤時臨時檔案清理成功');
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
}

// 格式化逐字稿文字
function formatTranscript(transcription) {
  if (transcription.segments && transcription.segments.length > 0) {
    // 如果有分段資訊，加上時間戳記
    return transcription.segments
      .map(segment => {
        const startTime = formatTime(segment.start);
        const endTime = formatTime(segment.end);
        return `[${startTime} - ${endTime}] ${segment.text.trim()}`;
      })
      .join('\n\n');
  } else {
    // 如果沒有分段資訊，直接回傳文字
    return transcription.text || '';
  }
}

// 格式化時間 (秒 -> MM:SS)
function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
}

// 導出處理函數
module.exports = handler;
module.exports.default = handler;
