import React, { useState, useRef } from 'react';
import './App.css';

interface Episode {
  id: string;
  title: string;
  pubDate: string;
  duration: string;
  audioUrl: string;
}

const mockEpisodes: Episode[] = [
  {
    id: '1',
    title: 'EP01 - 歡迎來到 Podcast',
    pubDate: '2024-05-01',
    duration: '30:12',
    audioUrl: 'https://example.com/podcast/ep1.mp3',
  },
  {
    id: '2',
    title: 'EP02 - AI 與未來',
    pubDate: '2024-05-08',
    duration: '28:45',
    audioUrl: 'https://example.com/podcast/ep2.mp3',
  },
  {
    id: '3',
    title: 'EP03 - 技術與生活',
    pubDate: '2024-05-15',
    duration: '32:10',
    audioUrl: 'https://example.com/podcast/ep3.mp3',
  },
];

function App() {
  const [rssUrl, setRssUrl] = useState('');
  const [episodes, setEpisodes] = useState<Episode[]>(mockEpisodes);
  const [selected, setSelected] = useState<string[]>([]);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [downloadSpeed, setDownloadSpeed] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const handleSelect = (id: string) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((sid) => sid !== id) : [...prev, id]
    );
  };

  const handleSelectAll = () => {
    setSelected(episodes.map((e) => e.id));
  };

  const handleDeselectAll = () => {
    setSelected([]);
  };

  const parseRssFeed = async (url: string) => {
    try {
      // CORS 代理服務列表（按優先順序）
      const corsProxies = [
        '', // 先嘗試直接請求
        'https://api.allorigins.win/raw?url=',
        'https://corsproxy.io/?',
        'https://cors-anywhere.herokuapp.com/',
        'https://cors.bridged.cc/',
        'https://yacdn.org/proxy/'
      ];

      let response: Response | null = null;
      let lastError: Error | null = null;

      // 依序嘗試每個代理
      for (const proxy of corsProxies) {
        try {
          const requestUrl = proxy ? proxy + encodeURIComponent(url) : url;
          console.log(`嘗試載入 RSS feed: ${proxy ? `使用代理 ${proxy}` : '直接請求'}`);
          
          response = await fetch(requestUrl, {
            method: 'GET',
            headers: {
              'Accept': 'application/rss+xml, application/xml, text/xml, */*',
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
            }
          });
          
          if (response.ok) {
            console.log(`RSS feed 載入成功: ${proxy ? `使用代理 ${proxy}` : '直接請求'}`);
            break;
          } else {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }
        } catch (error) {
          console.log(`RSS feed 載入失敗 (${proxy || '直接請求'}):`, error);
          lastError = error as Error;
          response = null;
          continue;
        }
      }

      if (!response) {
        throw lastError || new Error('所有載入方法都失敗');
      }

      const text = await response.text();
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(text, 'text/xml');
      
      // 檢查是否有解析錯誤
      const parseError = xmlDoc.querySelector('parsererror');
      if (parseError) {
        throw new Error('RSS feed 格式錯誤');
      }

      const items = xmlDoc.querySelectorAll('item');
      
      if (items.length === 0) {
        throw new Error('RSS feed 中沒有找到任何集數');
      }

      const parsedEpisodes: Episode[] = Array.from(items).map((item, index) => {
        const title = item.querySelector('title')?.textContent || `EP${index + 1}`;
        const pubDate = item.querySelector('pubDate')?.textContent || '';
        const duration = item.querySelector('itunes\\:duration')?.textContent || '00:00';
        const audioUrl = item.querySelector('enclosure')?.getAttribute('url') || '';
        return {
          id: String(index + 1),
          title,
          pubDate,
          duration,
          audioUrl,
        };
      });
      
      setEpisodes(parsedEpisodes);
      console.log(`成功解析 ${parsedEpisodes.length} 個集數`);
    } catch (error) {
      console.error('解析 RSS feed 時發生錯誤:', error);
      alert(`解析 RSS feed 失敗：${error instanceof Error ? error.message : '未知錯誤'}\n\n請確認連結是否正確，或稍後再試。`);
    }
  };

  const handleCopyLink = async (audioUrl: string, title: string) => {
    try {
      await navigator.clipboard.writeText(audioUrl);
      alert(`已複製 "${title}" 的音檔連結到剪貼簿！`);
    } catch (error) {
      console.error('複製失敗:', error);
      // 備用方案：顯示連結讓用戶手動複製
      prompt('複製下方連結:', audioUrl);
    }
  };

  const handleLoadRss = () => {
    if (!rssUrl) {
      alert('請輸入 RSS feed 連結');
      return;
    }
    parseRssFeed(rssUrl);
  };

  const handleDownload = async () => {
    if (isPaused) {
      setIsPaused(false);
      return;
    }
    setDownloading(true);
    setProgress(0);
    
    // CORS 代理服務列表（按優先順序）
    const corsProxies = [
      'https://cors-anywhere.herokuapp.com/',
      'https://api.allorigins.win/raw?url=',
      'https://corsproxy.io/?',
      'https://cors.bridged.cc/',
      'https://yacdn.org/proxy/'
    ];
    
    for (let i = 0; i < selected.length; i++) {
      const episode = episodes.find((ep) => ep.id === selected[i]);
      if (!episode || !episode.audioUrl) {
        console.warn(`跳過集數 ${episode?.title || selected[i]}：沒有音檔連結`);
        continue;
      }
      
      let downloadSuccess = false;
      
      // 首先嘗試直接下載
      try {
        console.log(`嘗試直接下載: ${episode.title}`);
        await downloadFile(episode.audioUrl, episode);
        downloadSuccess = true;
        console.log(`直接下載成功: ${episode.title}`);
      } catch (error) {
        console.log(`直接下載失敗，嘗試使用代理: ${error}`);
      }
      
      // 如果直接下載失敗，嘗試使用 CORS 代理
      if (!downloadSuccess) {
        for (const proxy of corsProxies) {
          try {
            console.log(`嘗試使用代理 ${proxy} 下載: ${episode.title}`);
            const proxiedUrl = proxy + encodeURIComponent(episode.audioUrl);
            await downloadFile(proxiedUrl, episode);
            downloadSuccess = true;
            console.log(`代理下載成功: ${episode.title}`);
            break;
          } catch (error) {
            console.log(`代理 ${proxy} 下載失敗: ${error}`);
            continue;
          }
        }
      }
      
      // 如果所有方法都失敗
      if (!downloadSuccess) {
        console.error(`所有下載方法都失敗: ${episode.title}`);
        const userChoice = window.confirm(
          `無法下載 "${episode.title}"。\n\n` +
          `是否要在新分頁中打開音檔連結，讓你手動下載？\n\n` +
          `點擊「確定」打開連結，點擊「取消」跳過此集數。`
        );
        
        if (userChoice) {
          window.open(episode.audioUrl, '_blank');
        }
      }
      
      // 更新進度
      setProgress(Math.round(((i + 1) / selected.length) * 100));
      
      // 在下載之間稍作延遲
      if (i < selected.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    setDownloading(false);
    setProgress(0);
    setDownloadSpeed(0);
    setIsPaused(false);
    alert('批量下載完成！');
  };

  // 下載檔案的輔助函數
  const downloadFile = async (url: string, episode: Episode) => {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'audio/*,*/*',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    // 讀取音檔數據
    const blob = await response.blob();
    
    // 確定檔案副檔名
    const contentType = response.headers.get('content-type') || '';
    let extension = '.mp3'; // 預設
    
    if (contentType.includes('mp4') || contentType.includes('m4a')) {
      extension = '.m4a';
    } else if (contentType.includes('wav')) {
      extension = '.wav';
    } else if (contentType.includes('ogg')) {
      extension = '.ogg';
    } else if (contentType.includes('aac')) {
      extension = '.aac';
    }
    
    // 從 URL 推測副檔名（如果 Content-Type 不明確）
    if (extension === '.mp3') {
      const urlLower = episode.audioUrl.toLowerCase();
      if (urlLower.includes('.m4a')) extension = '.m4a';
      else if (urlLower.includes('.wav')) extension = '.wav';
      else if (urlLower.includes('.ogg')) extension = '.ogg';
      else if (urlLower.includes('.aac')) extension = '.aac';
    }
    
    // 清理檔案名稱
    const cleanTitle = episode.title
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 100);
    
    // 創建下載連結
    const downloadUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = `${cleanTitle}${extension}`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    
    // 清理
    setTimeout(() => {
      window.URL.revokeObjectURL(downloadUrl);
      document.body.removeChild(a);
    }, 100);
  };

  const handlePause = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setIsPaused(true);
    }
  };

  return (
    <div className="App">
      <header className="App-header">
        <h1>🎧 Podcast 批量下載工具</h1>
        <div style={{ margin: '20px 0' }}>
          <input
            type="text"
            value={rssUrl}
            onChange={(e) => setRssUrl(e.target.value)}
            placeholder="請輸入 Podcast RSS Feed 連結"
            style={{ width: 320, padding: 8, borderRadius: 6, border: '1px solid #ccc', fontSize: 16 }}
            disabled={downloading}
          />
          <button
            onClick={handleLoadRss}
            style={{ marginLeft: 12, padding: '8px 18px', borderRadius: 6, fontSize: 16, background: '#61dafb', color: '#222', border: 'none', cursor: 'pointer' }}
            disabled={downloading}
          >
            載入
          </button>
        </div>
        <div style={{ background: '#fff', color: '#222', borderRadius: 12, padding: 24, minWidth: 400, boxShadow: '0 2px 16px #0001' }}>
          <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 600 }}>集數列表</span>
            <div>
              <button onClick={handleSelectAll} style={{ marginRight: 8, padding: '4px 10px', borderRadius: 4, border: '1px solid #61dafb', background: '#e3f7fd', cursor: 'pointer' }}>全選</button>
              <button onClick={handleDeselectAll} style={{ padding: '4px 10px', borderRadius: 4, border: '1px solid #bbb', background: '#f5f5f5', cursor: 'pointer' }}>全不選</button>
            </div>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f0f8ff' }}>
                <th></th>
                <th style={{ textAlign: 'left', padding: 6 }}>標題</th>
                <th style={{ padding: 6 }}>日期</th>
                <th style={{ padding: 6 }}>時長</th>
                <th style={{ padding: 6 }}>音檔連結</th>
              </tr>
            </thead>
            <tbody>
              {episodes.map((ep) => (
                <tr key={ep.id} style={{ borderBottom: '1px solid #eee' }}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.includes(ep.id)}
                      onChange={() => handleSelect(ep.id)}
                      disabled={downloading}
                    />
                  </td>
                  <td style={{ textAlign: 'left', padding: 6 }}>{ep.title}</td>
                  <td style={{ padding: 6 }}>{ep.pubDate}</td>
                  <td style={{ padding: 6 }}>{ep.duration}</td>
                  <td style={{ padding: 6 }}>
                    {ep.audioUrl ? (
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <a 
                          href={ep.audioUrl} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          style={{ color: '#61dafb', textDecoration: 'none', fontSize: 12 }}
                          title="點擊在新分頁中打開音檔連結"
                        >
                          🔗 連結
                        </a>
                        <button
                          onClick={() => handleCopyLink(ep.audioUrl, ep.title)}
                          style={{ 
                            background: 'none', 
                            border: '1px solid #ddd', 
                            borderRadius: 3, 
                            padding: '2px 6px', 
                            fontSize: 10, 
                            cursor: 'pointer',
                            color: '#666'
                          }}
                          title="複製連結到剪貼簿"
                        >
                          📋
                        </button>
                      </div>
                    ) : (
                      <span style={{ color: '#999', fontSize: 12 }}>無連結</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 18, display: 'flex', alignItems: 'center' }}>
            <button
              onClick={downloading ? handlePause : handleDownload}
              disabled={selected.length === 0}
              style={{ padding: '8px 24px', borderRadius: 6, fontSize: 16, background: '#222', color: '#fff', border: 'none', cursor: selected.length === 0 ? 'not-allowed' : 'pointer' }}
            >
              {downloading ? (isPaused ? '繼續下載' : '暫停下載') : `批量下載 (${selected.length})`}
            </button>
            {downloading && (
              <div style={{ marginLeft: 18, width: 180, height: 12, background: '#eee', borderRadius: 6, overflow: 'hidden' }}>
                <div style={{ width: `${progress}%`, height: '100%', background: '#61dafb', transition: 'width 0.3s' }}></div>
              </div>
            )}
            {downloading && (
              <span style={{ marginLeft: 12, fontSize: 14 }}>{downloadSpeed} KB/s</span>
            )}
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color: '#666', textAlign: 'center' }}>
            💡 下載會自動嘗試多種方法繞過限制，如果失敗會提示手動下載選項
          </div>
        </div>
      </header>
    </div>
  );
}

export default App;
