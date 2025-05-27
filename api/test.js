// 簡單的測試 API
function handler(req, res) {
  console.log(`=== 測試 API 請求 ===`);
  console.log(`方法: ${req.method}`);
  console.log(`URL: ${req.url}`);
  console.log(`Headers:`, JSON.stringify(req.headers, null, 2));
  
  // 設定 CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    console.log('處理 OPTIONS 請求');
    res.status(200).end();
    return;
  }

  // 返回測試響應
  res.status(200).json({
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
        PASSWORD: process.env.PASSWORD ? '已設置' : '未設置',
        PORT: process.env.PORT || '未設置'
      }
    }
  });
}

module.exports = handler;
module.exports.default = handler; 