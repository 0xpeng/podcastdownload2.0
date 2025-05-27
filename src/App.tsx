import React, { useState, useRef } from 'react';
import './App.css';

interface Episode {
  id: string;
  title: string;
  pubDate: string;
  duration: string;
  audioUrl: string;
  transcriptStatus?: 'none' | 'processing' | 'completed' | 'error';
  transcriptText?: string;
  transcriptUrl?: string;
}

const mockEpisodes: Episode[] = [
  {
    id: '1',
    title: 'EP01 - 歡迎來到 Podcast',
    pubDate: '2024-05-01',
    duration: '30:12',
    audioUrl: 'https://example.com/podcast/ep1.mp3',
    transcriptStatus: 'none',
  },
  {
    id: '2',
    title: 'EP02 - AI 與未來',
    pubDate: '2024-05-08',
    duration: '28:45',
    audioUrl: 'https://example.com/podcast/ep2.mp3',
    transcriptStatus: 'none',
  },
  {
    id: '3',
    title: 'EP03 - 技術與生活',
    pubDate: '2024-05-15',
    duration: '32:10',
    audioUrl: 'https://example.com/podcast/ep3.mp3',
    transcriptStatus: 'none',
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
  const [transcribing, setTranscribing] = useState<Set<string>>(new Set());
  const [transcriptProgress, setTranscriptProgress] = useState<Map<string, number>>(new Map());
  const abortControllerRef = useRef<AbortController | null>(null);

  // 轉錄功能
  const handleTranscribe = async (episode: Episode) => {
    if (!episode.audioUrl) {
      alert('此集數沒有音檔連結');
      return;
    }

    setTranscribing(prev => new Set([...prev, episode.id]));
    setTranscriptProgress(prev => new Map([...prev, [episode.id, 0]]));
    
    // 更新集數狀態
    setEpisodes(prev => prev.map(ep => 
      ep.id === episode.id 
        ? { ...ep, transcriptStatus: 'processing' }
        : ep
    ));

    try {
      // 1. 下載音檔
      setTranscriptProgress(prev => new Map([...prev, [episode.id, 20]]));
      const audioBlob = await downloadAudioForTranscription(episode.audioUrl);
      
      // 2. 上傳到後端進行轉錄
      setTranscriptProgress(prev => new Map([...prev, [episode.id, 50]]));
      const transcript = await uploadForTranscription(audioBlob, episode);
      
      // 3. 更新狀態
      setTranscriptProgress(prev => new Map([...prev, [episode.id, 100]]));
      setEpisodes(prev => prev.map(ep => 
        ep.id === episode.id 
          ? { 
              ...ep, 
              transcriptStatus: 'completed',
              transcriptText: transcript.text,
              transcriptUrl: transcript.url 
            }
          : ep
      ));

      alert(`"${episode.title}" 轉錄完成！`);
    } catch (error) {
      console.error('轉錄失敗:', error);
      setEpisodes(prev => prev.map(ep => 
        ep.id === episode.id 
          ? { ...ep, transcriptStatus: 'error' }
          : ep
      ));
      alert(`轉錄失敗：${error instanceof Error ? error.message : '未知錯誤'}`);
    } finally {
      setTranscribing(prev => {
        const newSet = new Set(prev);
        newSet.delete(episode.id);
        return newSet;
      });
      setTranscriptProgress(prev => {
        const newMap = new Map(prev);
        newMap.delete(episode.id);
        return newMap;
      });
    }
  };

  // 下載音檔用於轉錄
  const downloadAudioForTranscription = async (audioUrl: string): Promise<Blob> => {
    const corsProxies = [
      '',
      'https://api.allorigins.win/raw?url=',
      'https://corsproxy.io/?',
    ];

    for (const proxy of corsProxies) {
      try {
        const requestUrl = proxy ? proxy + encodeURIComponent(audioUrl) : audioUrl;
        const response = await fetch(requestUrl);
        
        if (response.ok) {
          return await response.blob();
        }
      } catch (error) {
        console.log(`下載音檔失敗 (${proxy || '直接請求'}):`, error);
        continue;
      }
    }
    
    throw new Error('無法下載音檔進行轉錄');
  };

  // 上傳音檔到後端進行轉錄
  const uploadForTranscription = async (audioBlob: Blob, episode: Episode) => {
    const formData = new FormData();
    formData.append('audio', audioBlob, `${episode.title}.mp3`);
    formData.append('title', episode.title);
    formData.append('episodeId', episode.id);

    const response = await fetch('/api/transcribe', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`轉錄服務錯誤: ${response.statusText}`);
    }

    return await response.json();
  };

  // 下載逐字稿
  const handleDownloadTranscript = (episode: Episode) => {
    if (!episode.transcriptText) {
      alert('此集數沒有逐字稿');
      return;
    }

    const blob = new Blob([episode.transcriptText], { type: 'text/plain;charset=utf-8' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${episode.title}_逐字稿.txt`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    
    setTimeout(() => {
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    }, 100);
  };

  // 批量轉錄
  const handleBatchTranscribe = async () => {
    if (selected.length === 0) {
      alert('請先選擇要轉錄的集數');
      return;
    }

    const selectedEpisodes = episodes.filter(ep => selected.includes(ep.id));
    const confirmMessage = `確定要轉錄 ${selectedEpisodes.length} 個集數嗎？\n\n注意：轉錄可能需要較長時間，建議一次不要超過 5 個集數。`;
    
    if (!window.confirm(confirmMessage)) {
      return;
    }

    for (const episode of selectedEpisodes) {
      if (episode.transcriptStatus === 'completed') {
        console.log(`跳過已轉錄的集數: ${episode.title}`);
        continue;
      }
      
      await handleTranscribe(episode);
      
      // 在轉錄之間稍作延遲
      if (selectedEpisodes.indexOf(episode) < selectedEpisodes.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    alert('批量轉錄完成！');
  };

  // 原有的功能保持不變...
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
      const corsProxies = [
        '',
        'https://api.allorigins.win/raw?url=',
        'https://corsproxy.io/?',
        'https://cors-anywhere.herokuapp.com/',
        'https://cors.bridged.cc/',
        'https://yacdn.org/proxy/'
      ];

      let response: Response | null = null;
      let lastError: Error | null = null;

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
          transcriptStatus: 'none',
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
      
      try {
        console.log(`嘗試直接下載: ${episode.title}`);
        await downloadFile(episode.audioUrl, episode);
        downloadSuccess = true;
        console.log(`直接下載成功: ${episode.title}`);
      } catch (error) {
        console.log(`直接下載失敗，嘗試使用代理: ${error}`);
      }
      
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
      
      setProgress(Math.round(((i + 1) / selected.length) * 100));
      
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
    
    const blob = await response.blob();
    
    const contentType = response.headers.get('content-type') || '';
    let extension = '.mp3';
    
    if (contentType.includes('mp4') || contentType.includes('m4a')) {
      extension = '.m4a';
    } else if (contentType.includes('wav')) {
      extension = '.wav';
    } else if (contentType.includes('ogg')) {
      extension = '.ogg';
    } else if (contentType.includes('aac')) {
      extension = '.aac';
    }
    
    if (extension === '.mp3') {
      const urlLower = episode.audioUrl.toLowerCase();
      if (urlLower.includes('.m4a')) extension = '.m4a';
      else if (urlLower.includes('.wav')) extension = '.wav';
      else if (urlLower.includes('.ogg')) extension = '.ogg';
      else if (urlLower.includes('.aac')) extension = '.aac';
    }
    
    const cleanTitle = episode.title
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 100);
    
    const downloadUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = `${cleanTitle}${extension}`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    
    setTimeout(() => {
      window.URL.revokeObjectURL(downloadUrl);
      document.body.removeChild(a);
    }, 100);
  };

  const handlePause = () => {
    setIsPaused(true);
  };

  // 渲染轉錄狀態圖示
  const renderTranscriptStatus = (episode: Episode) => {
    const isTranscribing = transcribing.has(episode.id);
    const progress = transcriptProgress.get(episode.id) || 0;

    switch (episode.transcriptStatus) {
      case 'processing':
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ 
              width: '16px', 
              height: '16px', 
              border: '2px solid #f3f3f3',
              borderTop: '2px solid #007bff',
              borderRadius: '50%',
              animation: 'spin 1s linear infinite'
            }}></div>
            <span style={{ fontSize: '12px', color: '#666' }}>
              轉錄中 {progress}%
            </span>
          </div>
        );
      case 'completed':
        return (
          <span style={{ color: '#28a745', fontSize: '12px' }}>
            ✅ 已完成
          </span>
        );
      case 'error':
        return (
          <span style={{ color: '#dc3545', fontSize: '12px' }}>
            ❌ 失敗
          </span>
        );
      default:
        return (
          <span style={{ color: '#6c757d', fontSize: '12px' }}>
            📝 未轉錄
          </span>
        );
    }
  };

  return (
    <div className="App">
      <header className="App-header">
        <h1>🎧 Podcast批量下載與轉錄工具</h1>
        <p>輸入 RSS feed 連結，批量下載 podcast 集數並生成逐字稿</p>
      </header>

      <main className="main-content">
        <div className="input-section">
          <div className="input-group">
            <input
              type="url"
              value={rssUrl}
              onChange={(e) => setRssUrl(e.target.value)}
              placeholder="請輸入 RSS feed 連結..."
              className="rss-input"
            />
            <button onClick={handleLoadRss} className="load-button">
              載入集數
            </button>
          </div>
          <p className="hint">
            💡 提示：工具會自動嘗試多種方法下載音檔和生成逐字稿
          </p>
        </div>

        {episodes.length > 0 && (
          <div className="episodes-section">
            <div className="controls">
              <div className="selection-controls">
                <button onClick={handleSelectAll} className="select-button">
                  全選
                </button>
                <button onClick={handleDeselectAll} className="select-button">
                  全不選
                </button>
                <span className="selected-count">
                  已選擇 {selected.length} / {episodes.length} 個集數
                </span>
              </div>
              
              <div className="action-controls">
                <button
                  onClick={handleDownload}
                  disabled={selected.length === 0 || downloading}
                  className="download-button"
                >
                  {downloading ? '下載中...' : `批量下載 (${selected.length})`}
                </button>
                
                <button
                  onClick={handleBatchTranscribe}
                  disabled={selected.length === 0}
                  className="transcribe-button"
                  style={{ 
                    backgroundColor: '#28a745',
                    marginLeft: '10px'
                  }}
                >
                  🎤 批量轉錄 ({selected.length})
                </button>
              </div>
            </div>

            {downloading && (
              <div className="progress-section">
                <div className="progress-bar">
                  <div 
                    className="progress-fill" 
                    style={{ width: `${progress}%` }}
                  ></div>
                </div>
                <p>下載進度: {progress}%</p>
              </div>
            )}

            <div className="episodes-table">
              <table>
                <thead>
                  <tr>
                    <th>選擇</th>
                    <th>標題</th>
                    <th>發布日期</th>
                    <th>時長</th>
                    <th>音檔連結</th>
                    <th>轉錄狀態</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {episodes.map((episode) => (
                    <tr key={episode.id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.includes(episode.id)}
                          onChange={() => handleSelect(episode.id)}
                        />
                      </td>
                      <td className="episode-title">{episode.title}</td>
                      <td>{episode.pubDate}</td>
                      <td>{episode.duration}</td>
                      <td className="audio-url">
                        {episode.audioUrl ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <a 
                              href={episode.audioUrl} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              style={{ 
                                color: '#007bff',
                                textDecoration: 'none',
                                fontSize: '12px',
                                maxWidth: '200px',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap'
                              }}
                            >
                              🔗 音檔連結
                            </a>
                            <button
                              onClick={() => handleCopyLink(episode.audioUrl, episode.title)}
                              style={{
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                fontSize: '12px'
                              }}
                              title="複製連結"
                            >
                              📋
                            </button>
                          </div>
                        ) : (
                          <span style={{ color: '#999', fontSize: '12px' }}>無連結</span>
                        )}
                      </td>
                      <td>
                        {renderTranscriptStatus(episode)}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '4px' }}>
                          <button
                            onClick={() => handleTranscribe(episode)}
                            disabled={
                              !episode.audioUrl || 
                              transcribing.has(episode.id) ||
                              episode.transcriptStatus === 'processing'
                            }
                            style={{
                              padding: '4px 8px',
                              fontSize: '12px',
                              backgroundColor: episode.transcriptStatus === 'completed' ? '#6c757d' : '#007bff',
                              color: 'white',
                              border: 'none',
                              borderRadius: '4px',
                              cursor: transcribing.has(episode.id) ? 'not-allowed' : 'pointer'
                            }}
                            title={
                              episode.transcriptStatus === 'completed' 
                                ? '重新轉錄' 
                                : '開始轉錄'
                            }
                          >
                            🎤
                          </button>
                          
                          {episode.transcriptStatus === 'completed' && (
                            <button
                              onClick={() => handleDownloadTranscript(episode)}
                              style={{
                                padding: '4px 8px',
                                fontSize: '12px',
                                backgroundColor: '#28a745',
                                color: 'white',
                                border: 'none',
                                borderRadius: '4px',
                                cursor: 'pointer'
                              }}
                              title="下載逐字稿"
                            >
                              📄
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>

      <style jsx>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        
        .transcribe-button {
          background-color: #28a745;
          color: white;
          border: none;
          padding: 10px 20px;
          border-radius: 5px;
          cursor: pointer;
          font-size: 14px;
        }
        
        .transcribe-button:hover {
          background-color: #218838;
        }
        
        .transcribe-button:disabled {
          background-color: #6c757d;
          cursor: not-allowed;
        }
      `}</style>
    </div>
  );
}

export default App; 