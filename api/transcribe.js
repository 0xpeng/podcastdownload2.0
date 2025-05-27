// @vercel/node
const formidable = require('formidable');
const fs = require('fs');
const OpenAI = require('openai');

// 初始化 OpenAI 客戶端
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

module.exports = async function handler(req, res) {
  // 設定 CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: '只支援 POST 請求' });
    return;
  }

  try {
    // 解析上傳的檔案
    const form = formidable({
      maxFileSize: 25 * 1024 * 1024, // 25MB 限制
      keepExtensions: true,
    });

    const [fields, files] = await form.parse(req);
    
    const audioFile = files.audio?.[0];
    const title = fields.title?.[0] || 'Unknown';
    const episodeId = fields.episodeId?.[0] || 'unknown';

    if (!audioFile) {
      res.status(400).json({ error: '沒有找到音檔' });
      return;
    }

    console.log(`開始轉錄: ${title} (${episodeId})`);
    console.log(`檔案大小: ${(audioFile.size / 1024 / 1024).toFixed(2)}MB`);

    // 檢查檔案大小
    if (audioFile.size > 25 * 1024 * 1024) {
      res.status(400).json({ 
        error: '音檔太大，請確保檔案小於 25MB' 
      });
      return;
    }

    // 使用 OpenAI Whisper API 進行轉錄
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioFile.filepath),
      model: 'whisper-1',
      language: 'zh', // 指定中文
      response_format: 'verbose_json',
      timestamp_granularities: ['word'],
    });

    // 清理臨時檔案
    try {
      fs.unlinkSync(audioFile.filepath);
    } catch (cleanupError) {
      console.warn('清理臨時檔案失敗:', cleanupError);
    }

    // 格式化逐字稿文字
    const formattedText = formatTranscript(transcription);

    console.log(`轉錄完成: ${title}`);
    console.log(`文字長度: ${formattedText.length} 字元`);

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

  } catch (error) {
    console.error('轉錄錯誤:', error);
    
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
};

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
