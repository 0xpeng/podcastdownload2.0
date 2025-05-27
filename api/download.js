const https = require('https');
const http = require('http');
const { URL } = require('url');

async function handler(req, res) {
  console.log(`=== 音檔下載代理請求開始 ===`);
  console.log(`方法: ${req.method}`);
  console.log(`URL: ${req.url}`);
  
  // 設定 CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

  try {
    // 解析請求體
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });

    await new Promise((resolve) => {
      req.on('end', resolve);
    });

    const { audioUrl, title } = JSON.parse(body);
    
    if (!audioUrl) {
      res.status(400).json({ error: '缺少音檔 URL' });
      return;
    }

    console.log(`開始下載音檔: ${title || 'Unknown'}`);
    console.log(`音檔 URL: ${audioUrl}`);

    // 下載音檔
    const audioBuffer = await downloadAudio(audioUrl);
    
    console.log(`音檔下載完成，大小: ${(audioBuffer.length / 1024 / 1024).toFixed(2)}MB`);

    // 設置響應 headers
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audioBuffer.length);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(title || 'audio')}.mp3"`);
    
    // 返回音檔數據
    res.status(200).send(audioBuffer);

  } catch (error) {
    console.error('=== 音檔下載錯誤 ===');
    console.error('錯誤詳情:', error);
    console.error('錯誤堆疊:', error.stack);
    
    res.status(500).json({ 
      error: `音檔下載失敗: ${error.message}` 
    });
  }
}

// 下載音檔函數
async function downloadAudio(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const downloadWithRedirect = (currentUrl, redirectCount = 0) => {
      if (redirectCount > maxRedirects) {
        reject(new Error('重定向次數過多'));
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
        console.log(`響應 headers:`, response.headers);
        
        // 處理重定向
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          const redirectUrl = response.headers.location;
          console.log(`重定向到: ${redirectUrl}`);
          downloadWithRedirect(redirectUrl, redirectCount + 1);
          return;
        }
        
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
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
          resolve(buffer);
        });
        
        response.on('error', (error) => {
          console.error('響應錯誤:', error);
          reject(error);
        });
      });
      
      request.on('error', (error) => {
        console.error('請求錯誤:', error);
        reject(error);
      });
      
      request.on('timeout', () => {
        request.destroy();
        reject(new Error('下載超時'));
      });
    };
    
    downloadWithRedirect(url);
  });
}

// 導出處理函數
module.exports = handler;
module.exports.default = handler; 