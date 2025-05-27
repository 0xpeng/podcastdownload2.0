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

    console.log(`開始轉錄: ${episode.title}`);
    console.log(`音檔 URL: ${episode.audioUrl}`);

    setTranscribing(prev => {
      const newSet = new Set(prev);
      newSet.add(episode.id);
      return newSet;
    });
    setTranscriptProgress(prev => {
      const newMap = new Map(prev);
      newMap.set(episode.id, 0);
      return newMap;
    });
    
    // 更新集數狀態
    setEpisodes(prev => prev.map(ep => 
      ep.id === episode.id 
        ? { ...ep, transcriptStatus: 'processing' }
        : ep
    ));

    try {
      // 1. 下載音檔
      console.log('步驟 1: 開始下載音檔...');
      setTranscriptProgress(prev => {
        const newMap = new Map(prev);
        newMap.set(episode.id, 10);
        return newMap;
      });
      
      const startDownload = Date.now();
      const audioBlob = await downloadAudioForTranscription(episode.audioUrl);
      const downloadTime = Date.now() - startDownload;
      console.log(`音檔下載完成，耗時: ${downloadTime}ms，大小: ${(audioBlob.size / 1024 / 1024).toFixed(2)}MB`);
      
      // 2. 上傳到後端進行轉錄
      console.log('步驟 2: 開始上傳並轉錄...');
      setTranscriptProgress(prev => {
        const newMap = new Map(prev);
        newMap.set(episode.id, 30);
        return newMap;
      });
      
      const startTranscribe = Date.now();
      const transcript = await uploadForTranscription(audioBlob, episode);
      const transcribeTime = Date.now() - startTranscribe;
      console.log(`轉錄完成，耗時: ${transcribeTime}ms`);
      
      // 3. 更新狀態
      setTranscriptProgress(prev => {
        const newMap = new Map(prev);
        newMap.set(episode.id, 100);
        return newMap;
      });
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

      console.log(`"${episode.title}" 轉錄完成！`);
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
    console.log(`使用後端代理下載音檔: ${audioUrl}`);
    
    try {
      // 使用後端代理 API 下載音檔
      const response = await fetch('/api/download', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          audioUrl: audioUrl,
          title: 'audio'
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('代理下載 API 錯誤:', errorText);
        throw new Error(`代理下載失敗 (${response.status}): ${response.statusText}\n${errorText}`);
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength) {
        console.log(`音檔大小: ${(parseInt(contentLength) / 1024 / 1024).toFixed(2)}MB`);
      }

      const audioBlob = await response.blob();
      console.log(`音檔下載完成，實際大小: ${(audioBlob.size / 1024 / 1024).toFixed(2)}MB`);
      
      return audioBlob;
    } catch (error) {
      console.error('後端代理下載失敗，嘗試使用 CORS 代理:', error);
      
      // 如果後端代理失敗，回退到原來的 CORS 代理方法
      const corsProxies = [
        '',
        'https://api.allorigins.win/raw?url=',
        'https://corsproxy.io/?',
      ];

      let lastError: Error | null = null;

      for (const proxy of corsProxies) {
        try {
          const requestUrl = proxy ? proxy + encodeURIComponent(audioUrl) : audioUrl;
          console.log(`嘗試下載音檔: ${proxy || '直接請求'}`);
          
          const response = await fetch(requestUrl);
          
          if (response.ok) {
            const contentLength = response.headers.get('content-length');
            if (contentLength) {
              console.log(`音檔大小: ${(parseInt(contentLength) / 1024 / 1024).toFixed(2)}MB`);
            }
            return await response.blob();
          } else {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }
        } catch (error) {
          console.log(`下載音檔失敗 (${proxy || '直接請求'}):`, error);
          lastError = error instanceof Error ? error : new Error(String(error));
          continue;
        }
      }
      
      throw new Error(`無法下載音檔進行轉錄: ${lastError?.message || '所有方法都失敗'}`);
    }
  };

  // 上傳音檔到後端進行轉錄
  const uploadForTranscription = async (audioBlob: Blob, episode: Episode) => {
    console.log(`準備上傳音檔進行轉錄，檔案大小: ${(audioBlob.size / 1024 / 1024).toFixed(2)}MB`);
    
    const formData = new FormData();
    formData.append('audio', audioBlob, `${episode.title}.mp3`);
    formData.append('title', episode.title);
    formData.append('episodeId', episode.id);

    const response = await fetch('/api/transcribe', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('轉錄 API 錯誤:', errorText);
      throw new Error(`轉錄服務錯誤 (${response.status}): ${response.statusText}\n${errorText}`);
    }

    const result = await response.json();
    console.log('轉錄結果:', result);
    return result;
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
      console.log('RSS feed 原始內容 (前 500 字元):', text.substring(0, 500));
      
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(text, 'text/xml');
      
      const parseError = xmlDoc.querySelector('parsererror');
      if (parseError) {
        console.error('XML 解析錯誤:', parseError.textContent);
        throw new Error('RSS feed 格式錯誤');
      }

      const items = xmlDoc.querySelectorAll('item');
      console.log(`找到 ${items.length} 個 item 元素`);
      
      if (items.length === 0) {
        throw new Error('RSS feed 中沒有找到任何集數');
      }

      const parsedEpisodes: Episode[] = Array.from(items).map((item, index) => {
        // 提取標題 - 處理 CDATA
        const titleElement = item.querySelector('title');
        let title = titleElement?.textContent || `EP${index + 1}`;
        
        // 清理 CDATA 標記
        title = title.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
        
        // 提取發布日期
        const pubDateElement = item.querySelector('pubDate');
        let pubDate = pubDateElement?.textContent || '';
        
        // 提取時長 - 嘗試多種格式
        let duration = '';
        const durationSelectors = [
          'itunes\\:duration',
          'duration',
          'enclosure[length]'
        ];
        
        for (const selector of durationSelectors) {
          const durationElement = item.querySelector(selector);
          if (durationElement) {
            duration = durationElement.textContent || durationElement.getAttribute('length') || '';
            if (duration) break;
          }
        }
        
        if (!duration) duration = '00:00';
        
        // 提取音檔 URL - 嘗試多種方式
        let audioUrl = '';
        
        // 方法 1: enclosure 標籤
        const enclosureElement = item.querySelector('enclosure');
        if (enclosureElement) {
          audioUrl = enclosureElement.getAttribute('url') || '';
        }
        
        // 方法 2: link 標籤
        if (!audioUrl) {
          const linkElement = item.querySelector('link');
          if (linkElement) {
            const linkUrl = linkElement.textContent || '';
            if (linkUrl && (linkUrl.includes('.mp3') || linkUrl.includes('.m4a') || linkUrl.includes('player.soundon.fm'))) {
              audioUrl = linkUrl;
            }
          }
        }
        
        // 方法 3: guid 標籤 (SoundOn 特有)
        if (!audioUrl) {
          const guidElement = item.querySelector('guid');
          if (guidElement) {
            const guidUrl = guidElement.textContent || '';
            if (guidUrl && guidUrl.includes('player.soundon.fm')) {
              audioUrl = guidUrl;
            }
          }
        }
        
        // 方法 4: 在描述中尋找音檔連結
        if (!audioUrl) {
          const descriptionElement = item.querySelector('description');
          if (descriptionElement) {
            const description = descriptionElement.textContent || '';
            const audioUrlMatch = description.match(/https?:\/\/[^\s]+\.(mp3|m4a|wav|ogg)/i);
            if (audioUrlMatch) {
              audioUrl = audioUrlMatch[0];
            }
          }
        }
        
        // SoundOn 特殊處理：轉換播放器 URL 為下載 URL
        if (audioUrl && audioUrl.includes('player.soundon.fm')) {
          console.log(`檢測到 SoundOn 播放器 URL: ${audioUrl}`);
          // 嘗試從播放器 URL 提取實際音檔 URL
          // SoundOn 的 URL 格式通常是: https://player.soundon.fm/p/{podcast_id}/episodes/{episode_id}
          const soundonMatch = audioUrl.match(/player\.soundon\.fm\/p\/([^\/]+)\/episodes\/([^\/\?]+)/);
          if (soundonMatch) {
            const podcastId = soundonMatch[1];
            const episodeId = soundonMatch[2];
            // 構建可能的音檔 URL 格式
            const possibleUrls = [
              `https://rss.soundon.fm/rssf/${podcastId}/feedurl/${episodeId}/rssFileVip.mp3`,
              `https://filesb.soundon.fm/file/filesb/${episodeId}.mp3`,
              `https://files.soundon.fm/${episodeId}.mp3`,
              audioUrl // 保留原始 URL 作為備用
            ];
            
            // 使用第一個可能的 URL
            audioUrl = possibleUrls[0];
            console.log(`轉換後的 SoundOn 音檔 URL: ${audioUrl}`);
          }
        }
        
        console.log(`集數 ${index + 1}:`, {
          title: title.substring(0, 50),
          pubDate,
          duration,
          audioUrl: audioUrl.substring(0, 100)
        });
        
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
      
      // 檢查有多少集數有音檔連結
      const episodesWithAudio = parsedEpisodes.filter(ep => ep.audioUrl);
      console.log(`其中 ${episodesWithAudio.length} 個集數有音檔連結`);
      
      if (episodesWithAudio.length === 0) {
        alert('警告：解析成功但沒有找到任何音檔連結。這可能是因為該 Podcast 平台使用了特殊的音檔保護機制。');
      }
      
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
          <div className="transcript-progress">
            <div className="spinner"></div>
            <div className="transcript-progress-bar">
              <div 
                className="transcript-progress-fill" 
                style={{ width: `${progress}%` }}
              ></div>
            </div>
            <span className="transcript-status processing">
              {progress}%
            </span>
          </div>
        );
      case 'completed':
        return (
          <span className="transcript-status completed">
            ✅ 已完成
          </span>
        );
      case 'error':
        return (
          <span className="transcript-status error">
            ❌ 失敗
          </span>
        );
      default:
        return (
          <span className="transcript-status none">
            📝 未轉錄
          </span>
        );
    }
  };

  return (
    <div className="App">
      <header className="App-header">
        <h1> Podcast批量下載與轉錄工具</h1>
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
            💡 提示：工具會自動嘗試多種方法下載音檔和生成逐字稿<br/>
            🎤 轉錄功能：將音檔轉換成文字逐字稿，方便閱讀和搜尋內容
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
                  className="transcribe-button transcribe-button-override"
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
                          <div className="audio-link-container">
                            <a 
                              href={episode.audioUrl} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="audio-link"
                            >
                              🔗 音檔連結
                            </a>
                            <button
                              onClick={() => handleCopyLink(episode.audioUrl, episode.title)}
                              className="copy-button"
                              title="複製連結"
                            >
                              📋
                            </button>
                          </div>
                        ) : (
                          <span className="no-link">無連結</span>
                        )}
                      </td>
                      <td>
                        {renderTranscriptStatus(episode)}
                      </td>
                      <td>
                        <div className="action-buttons">
                          <button
                            onClick={() => handleTranscribe(episode)}
                            disabled={
                              !episode.audioUrl || 
                              transcribing.has(episode.id) ||
                              episode.transcriptStatus === 'processing'
                            }
                            className={`action-button transcribe-action-button ${
                              episode.transcriptStatus === 'completed' ? 'completed' : ''
                            }`}
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
                              className="action-button download-transcript-button"
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
    </div>
  );
}

export default App; 