import React, { useState, useRef, useEffect } from 'react';
import './App.css';

// 時長格式化函數
const formatDuration = (duration: string | number): string => {
  // 如果已經是 MM:SS 格式，直接返回
  if (typeof duration === 'string' && duration.includes(':')) {
    return duration;
  }
  
  // 如果是秒數，轉換為 MM:SS
  const totalSeconds = typeof duration === 'string' ? parseInt(duration) : duration;
  if (isNaN(totalSeconds)) return '00:00';
  
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

// 音頻播放器組件
interface AudioPlayerProps {
  episode: Episode;
  isPlaying: boolean;
  onTogglePlay: () => void;
}

const AudioPlayer: React.FC<AudioPlayerProps> = ({ episode, isPlaying, onTogglePlay }) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [totalDuration, setTotalDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string>('');
  const [retryCount, setRetryCount] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string>('');

  // 檢查音頻URL是否有效
  const isValidAudioUrl = (url: string): boolean => {
    if (!url || url.trim() === '') return false;
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  };

  const audioUrl = episode.audioUrl;
  const isAudioValid = isValidAudioUrl(audioUrl);

  // 使用後端代理載入音頻 (優先方法，與下載功能相同的API)
  const loadAudioWithBackendProxy = async (): Promise<string> => {
    console.log(`🎵 [後端代理] 開始載入音頻: ${episode.title}`);
    console.log(`🎵 [後端代理] 音頻URL: ${audioUrl}`);
    
    try {
      // 使用與下載相同的後端代理 API
      const response = await fetch('/api/download', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          audioUrl: audioUrl,
          title: episode.title
        }),
      });

      console.log(`🎵 [後端代理] 響應狀態: ${response.status} ${response.statusText}`);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`🚨 [後端代理] 詳細錯誤: ${errorText}`);
        throw new Error(`後端代理錯誤 (${response.status}): ${response.statusText}`);
      }

      const audioBlob = await response.blob();
      console.log(`✅ [後端代理] 音頻載入成功: ${(audioBlob.size / 1024 / 1024).toFixed(2)}MB`);
      
      // 驗證 Blob 是否為有效的音頻類型
      if (audioBlob.size < 1024) {
        throw new Error('後端返回的音頻文件太小，可能無效');
      }

      // 創建 Blob URL
      const blobUrl = URL.createObjectURL(audioBlob);
      console.log(`🔗 [後端代理] 創建 Blob URL: ${blobUrl.substring(0, 50)}...`);
      return blobUrl;
      
    } catch (error) {
      console.error('🚨 [後端代理] 載入失敗:', error);
      throw error;
    }
  };

  // 備用方案：使用前端 CORS 代理 (僅作為備用)
  const loadAudioWithFrontendProxy = async (): Promise<string> => {
    console.log(`🌐 [前端代理] 開始載入音頻: ${episode.title}`);
    
    // 移除失效的代理，只保留相對可靠的
    const corsProxies = [
      'https://corsproxy.io/?',
      // 移除其他不穩定的代理
    ];
    
    for (const proxy of corsProxies) {
      try {
        const testUrl = proxy + encodeURIComponent(audioUrl);
        console.log(`🌐 [前端代理] 嘗試代理: ${proxy}`);
        
        const response = await fetch(testUrl, {
          method: 'GET',
          headers: {
            'Accept': 'audio/*,*/*',
            'User-Agent': 'Mozilla/5.0 (compatible; PodcastPlayer/1.0)'
          }
        });
        
        if (response.ok) {
          const audioBlob = await response.blob();
          if (audioBlob.size > 1024) {
            console.log(`✅ [前端代理] 成功: ${(audioBlob.size / 1024 / 1024).toFixed(2)}MB`);
            return URL.createObjectURL(audioBlob);
          } else {
            console.warn(`⚠️ [前端代理] 文件太小: ${audioBlob.size}B`);
          }
        } else {
          console.warn(`⚠️ [前端代理] HTTP錯誤: ${response.status}`);
        }
      } catch (error) {
        console.log(`❌ [前端代理] 失敗 (${proxy}):`, error);
        continue;
      }
    }
    
    throw new Error('所有前端代理都失敗');
  };

  // 載入音頻 - 修改優先級邏輯
  const loadAudio = async () => {
    if (!isAudioValid) {
      setErrorMessage('無效的音頻連結');
      return;
    }
    
    setIsLoading(true);
    setHasError(false);
    setErrorMessage('');
    
    // 清理舊的 Blob URL
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      setBlobUrl('');
    }
    
    try {
      let newBlobUrl: string;
      
      console.log(`🎯 [音頻載入] 開始載入: ${episode.title}`);
      
      // 1. 優先使用後端代理 (與下載功能相同，最可靠)
      try {
        console.log(`📡 [載入策略] 嘗試後端代理...`);
        newBlobUrl = await loadAudioWithBackendProxy();
        console.log(`✅ [載入策略] 後端代理成功`);
      } catch (backendError) {
        console.warn('⚠️ [載入策略] 後端代理失敗，嘗試前端代理:', backendError);
        
        // 2. 備用方案：使用前端代理
        try {
          console.log(`🌐 [載入策略] 嘗試前端代理...`);
          newBlobUrl = await loadAudioWithFrontendProxy();
          console.log(`✅ [載入策略] 前端代理成功`);
        } catch (frontendError) {
          console.error('❌ [載入策略] 前端代理也失敗:', frontendError);
          
          // 記錄詳細錯誤信息
          const backendMsg = backendError instanceof Error ? backendError.message : String(backendError);
          const frontendMsg = frontendError instanceof Error ? frontendError.message : String(frontendError);
          const detailedError = `音頻載入完全失敗:\n- 後端代理: ${backendMsg}\n- 前端代理: ${frontendMsg}`;
          setErrorMessage(detailedError);
          throw new Error(detailedError);
        }
      }
      
      setBlobUrl(newBlobUrl);
      setIsLoading(false);
      console.log(`🎯 [音頻載入] 載入完成: ${episode.title}`);
      
    } catch (error) {
      console.error(`❌ [音頻載入] 完全失敗: ${episode.title}`, error);
      setHasError(true);
      setIsLoading(false);
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  // 重試機制
  const handleRetry = () => {
    const newRetryCount = retryCount + 1;
    setRetryCount(newRetryCount);
    console.log(`🔄 [重試] 第 ${newRetryCount} 次重試: ${episode.title}`);
    loadAudio();
  };

  // 當音頻URL變化時載入音頻
  useEffect(() => {
    if (isAudioValid) {
      console.log(`🎬 [生命週期] 音頻URL變化，開始載入: ${episode.title}`);
      loadAudio();
    }
    
    // 清理函數
    return () => {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    };
  }, [audioUrl, isAudioValid, retryCount]);

  // 設置音頻事件監聽器
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !blobUrl) return;

    console.log(`🔗 [音頻設置] 設置音頻源: ${blobUrl.substring(0, 50)}...`);
    
    const updateTime = () => setCurrentTime(audio.currentTime);
    const updateDuration = () => setTotalDuration(audio.duration || 0);
    const handleLoadStart = () => {
      console.log('🔄 [音頻事件] 開始載入...');
    };
    const handleCanPlay = () => {
      console.log('✅ [音頻事件] 可以播放');
    };
    const handleLoadedMetadata = () => {
      setTotalDuration(audio.duration || 0);
      console.log(`⏱️ [音頻事件] 時長: ${audio.duration}秒`);
    };
    const handleError = (e: Event) => {
      console.error('🚨 [音頻事件] 播放錯誤:', e);
      if (audio.error) {
        const errorMessages = {
          1: 'MEDIA_ERR_ABORTED - 音頻下載被中止',
          2: 'MEDIA_ERR_NETWORK - 網絡錯誤',
          3: 'MEDIA_ERR_DECODE - 音頻解碼錯誤',
          4: 'MEDIA_ERR_SRC_NOT_SUPPORTED - 音頻格式不支援'
        };
        const errorMsg = errorMessages[audio.error.code as keyof typeof errorMessages] || `未知錯誤 (${audio.error.code})`;
        console.error(`🚨 [音頻事件] 錯誤詳情: ${errorMsg}`);
        setErrorMessage(`播放錯誤: ${errorMsg}`);
      }
      setHasError(true);
    };

    audio.addEventListener('timeupdate', updateTime);
    audio.addEventListener('durationchange', updateDuration);
    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('loadstart', handleLoadStart);
    audio.addEventListener('canplay', handleCanPlay);
    audio.addEventListener('error', handleError);

    // 設置音頻源
    audio.src = blobUrl;

    return () => {
      audio.removeEventListener('timeupdate', updateTime);
      audio.removeEventListener('durationchange', updateDuration);
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('loadstart', handleLoadStart);
      audio.removeEventListener('canplay', handleCanPlay);
      audio.removeEventListener('error', handleError);
    };
  }, [blobUrl]);

  // 播放控制
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !blobUrl || hasError) return;

    if (isPlaying) {
      console.log(`▶️ [播放控制] 开始播放: ${episode.title}`);
      console.log(`▶️ [播放控制] 音频状态检查:`);
      console.log(`   - readyState: ${audio.readyState} (4=HAVE_ENOUGH_DATA)`);
      console.log(`   - networkState: ${audio.networkState}`);
      console.log(`   - duration: ${audio.duration}`);
      console.log(`   - currentTime: ${audio.currentTime}`);
      console.log(`   - paused: ${audio.paused}`);
      console.log(`   - volume: ${audio.volume}`);
      console.log(`   - muted: ${audio.muted}`);
      console.log(`   - src: ${audio.src.substring(0, 50)}...`);
      
      const playPromise = audio.play();
      
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            console.log(`✅ [播放控制] 播放成功: ${episode.title}`);
          })
          .catch(error => {
            console.error('🚨 [播放控制] 播放失败:', error);
            console.error('🚨 [播放控制] 错误类型:', error.name);
            console.error('🚨 [播放控制] 错误详情:', error.message);
            
            // 常见播放错误的解决建议
            if (error.name === 'NotAllowedError') {
              setErrorMessage('播放被浏览器阻止 - 请先点击页面任意位置以允许音频播放');
              alert('播放被浏览器阻止\n\n解决方案：\n1. 请先点击页面任意位置\n2. 然后再尝试播放音频\n\n这是浏览器的安全策略要求。');
            } else if (error.name === 'NotSupportedError') {
              setErrorMessage('音频格式不支持 - 请尝试其他集数');
            } else {
              setErrorMessage(`播放失败: ${error.message}`);
            }
            
            setHasError(true);
          });
      }
    } else {
      console.log(`⏸️ [播放控制] 暂停播放: ${episode.title}`);
      audio.pause();
    }
  }, [isPlaying, blobUrl, hasError]);

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    if (!audio || !totalDuration) return;
    
    const newTime = (parseFloat(e.target.value) / 100) * totalDuration;
    audio.currentTime = newTime;
    setCurrentTime(newTime);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseFloat(e.target.value) / 100;
    setVolume(newVolume);
    if (audioRef.current) {
      audioRef.current.volume = newVolume;
    }
  };

  const progressPercentage = totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0;

  // 確定播放按鈕的狀態
  const isButtonDisabled = !isAudioValid || isLoading;
  const buttonTitle = hasError ? `音頻載入失敗 (重試 ${retryCount} 次) - 點擊重試\n${errorMessage}` : 
                     !isAudioValid ? '無效的音頻連結' :
                     isLoading ? '正在載入音頻...' :
                     !blobUrl ? '準備載入...' :
                     isPlaying ? '暫停' : '播放';

  // 新增：调试按钮状态
  console.log(`🎮 [按钮状态] ${episode.title}:`, {
    isButtonDisabled,
    isAudioValid,
    isLoading,
    hasError,
    blobUrl: !!blobUrl,
    isPlaying,
    buttonTitle
  });

  // 新增：按钮点击处理函数
  const handlePlayButtonClick = () => {
    console.log(`🎮 [按钮点击] 播放按钮被点击: ${episode.title}`);
    console.log(`🎮 [按钮点击] 当前状态:`, {
      hasError,
      isButtonDisabled,
      isPlaying
    });
    
    if (hasError) {
      console.log(`🔄 [按钮点击] 执行重试操作`);
      handleRetry();
    } else {
      console.log(`▶️ [按钮点击] 执行播放切换操作`);
      onTogglePlay();
    }
  };

  return (
    <div className={`audio-player ${isPlaying ? 'playing' : ''} ${hasError ? 'error' : ''} ${isLoading ? 'loading' : ''}`}>
      <audio
        ref={audioRef}
        preload="metadata"
      />
      
      <div className="player-controls">
        <button
          onClick={handlePlayButtonClick}
          disabled={isButtonDisabled}
          className="play-button"
          title={buttonTitle}
          style={{
            pointerEvents: isButtonDisabled ? 'none' : 'auto',
            opacity: isButtonDisabled ? 0.5 : 1,
            cursor: isButtonDisabled ? 'not-allowed' : 'pointer'
          }}
        >
          {hasError ? '🔄' : 
           isLoading ? '⏳' : 
           !blobUrl ? '⬇️' :
           isPlaying ? '⏸️' : '▶️'}
        </button>
        
        <div className="time-info">
          <span className="current-time">{formatDuration(Math.floor(currentTime))}</span>
          <span className="time-separator">/</span>
          <span className="total-time">{formatDuration(Math.floor(totalDuration))}</span>
        </div>
      </div>

      <div className="progress-container">
        <input
          type="range"
          min="0"
          max="100"
          value={progressPercentage}
          onChange={handleSeek}
          className="progress-slider"
          disabled={!totalDuration || hasError || isLoading}
        />
      </div>

      <div className="volume-container">
        <span className="volume-icon">🔊</span>
        <input
          type="range"
          min="0"
          max="100"
          value={volume * 100}
          onChange={handleVolumeChange}
          className="volume-slider"
          disabled={hasError || isLoading}
        />
      </div>
    </div>
  );
};

interface Episode {
  id: string;
  title: string;
  pubDate: string;
  duration: string;
  audioUrl: string;
  transcriptStatus?: 'none' | 'processing' | 'completed' | 'error';
  transcriptText?: string;
  transcriptUrl?: string;
  // 新增：增強轉錄數據
  transcriptFormats?: {
    txt?: string;
    srt?: string;
    vtt?: string;
    json?: string;
  };
  transcriptMetadata?: {
    processed?: boolean;
    totalSegments?: number;
    speakerDiarization?: boolean;
    contentType?: string;
    outputFormats?: string[];
  };
}

// 新增：轉錄設置接口
interface TranscriptionSettings {
  outputFormats: string[];
  contentType: string;
  enableSpeakerDiarization: boolean;
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
  const [rssUrl, setRssUrl] = useState('https://feeds.soundon.fm/podcasts/066b9fb0-0c9a-417f-a97b-57d04bcc6aca.xml');
  const [episodes, setEpisodes] = useState<Episode[]>(mockEpisodes);
  const [selected, setSelected] = useState<string[]>([]);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [downloadSpeed, setDownloadSpeed] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [transcribing, setTranscribing] = useState<Set<string>>(new Set());
  const [transcriptProgress, setTranscriptProgress] = useState<Map<string, number>>(new Map());
  
  // 新增：轉錄設置狀態
  const [transcriptionSettings, setTranscriptionSettings] = useState<TranscriptionSettings>({
    outputFormats: ['txt'],
    contentType: 'podcast',
    enableSpeakerDiarization: false
  });
  const [showTranscriptionSettings, setShowTranscriptionSettings] = useState(false);
  
  // 新增：音頻播放器狀態
  const [currentlyPlaying, setCurrentlyPlaying] = useState<string | null>(null);
  
  // 新增：音頻測試狀態
  const [testingAudio, setTestingAudio] = useState(false);
  const [audioTestResults, setAudioTestResults] = useState<Map<string, 'testing' | 'valid' | 'invalid'>>(new Map());
  
  // 新增：用户交互检测
  const [userInteracted, setUserInteracted] = useState(false);
  
  const abortControllerRef = useRef<AbortController | null>(null);

  // 新增：检测用户交互以允许音频播放
  useEffect(() => {
    const handleUserInteraction = () => {
      if (!userInteracted) {
        setUserInteracted(true);
        console.log('✅ [用户交互] 检测到用户交互，音频播放已解锁');
        
        // 尝试创建和播放一个静音音频以解锁浏览器音频上下文
        try {
          const audio = new Audio();
          audio.src = 'data:audio/mpeg;base64,SUQzBAAAAAABEVRYWFgAAAAtAAADY29tbWVudABCaWdTb3VuZEJhbmsuY29tIC8gTGFTb25vdGhlcXVlLm9yZwBURU5DAAAAHQAAAAM=';
          audio.volume = 0;
          audio.play().catch(() => {
            // 忽略错误，这只是为了解锁音频上下文
          });
        } catch (error) {
          // 忽略错误
        }
      }
    };

    // 监听多种用户交互事件
    const events = ['click', 'keydown', 'touchstart', 'mousedown'];
    events.forEach(event => {
      document.addEventListener(event, handleUserInteraction, { once: true });
    });

    return () => {
      events.forEach(event => {
        document.removeEventListener(event, handleUserInteraction);
      });
    };
  }, [userInteracted]);

  // 新增：更新轉錄設置
  const updateTranscriptionSettings = (key: keyof TranscriptionSettings, value: any) => {
    setTranscriptionSettings(prev => ({
      ...prev,
      [key]: value
    }));
  };

  // 新增：音頻播放控制函數
  const handleTogglePlay = (episodeId: string) => {
    console.log(`🎮 [播放控制] 用户点击播放按钮: ${episodeId}`);
    console.log(`🎮 [播放控制] 用户交互状态: ${userInteracted}`);
    
    // 检查用户是否已经与页面交互
    if (!userInteracted) {
      console.log('⚠️ [播放控制] 检测到首次播放，触发用户交互');
      setUserInteracted(true);
    }
    
    if (currentlyPlaying === episodeId) {
      setCurrentlyPlaying(null); // 暫停當前播放
      console.log(`⏸️ [播放控制] 暂停播放: ${episodeId}`);
    } else {
      setCurrentlyPlaying(episodeId); // 播放新的集數
      console.log(`▶️ [播放控制] 开始播放: ${episodeId}`);
    }
  };

  // 新增：測試單個音頻鏈接 - 使用後端代理
  const testAudioUrl = async (episode: Episode): Promise<'valid' | 'invalid'> => {
    if (!episode.audioUrl) return 'invalid';
    
    console.log(`🔍 [音頻測試] 開始測試: ${episode.title}`);
    console.log(`🔍 [音頻測試] 音頻URL: ${episode.audioUrl}`);
    
    try {
      // 優先使用後端代理進行測試（與播放器相同的方法）
      console.log(`🔍 [音頻測試] 使用後端代理測試...`);
      
      const response = await fetch('/api/download', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          audioUrl: episode.audioUrl,
          title: `test_${episode.title}`
        }),
        signal: AbortSignal.timeout(15000), // 15秒超時
      });

      if (response.ok) {
        const contentLength = response.headers.get('content-length');
        const contentType = response.headers.get('content-type') || '';
        
        // 檢查是否為音頻文件
        const isAudioType = contentType.includes('audio') || 
                           contentType.includes('mp3') || 
                           contentType.includes('mp4') ||
                           contentType.includes('mpeg') ||
                           contentType.includes('m4a') ||
                           contentType.includes('wav') ||
                           contentType.includes('ogg');
        
        if (isAudioType) {
          const sizeMB = contentLength ? (parseInt(contentLength) / 1024 / 1024).toFixed(2) : '未知';
          console.log(`✅ [音頻測試] 後端代理測試成功: ${episode.title} - ${sizeMB}MB - ${contentType}`);
          return 'valid';
        } else {
          console.warn(`⚠️ [音頻測試] 響應成功但不是音頻: ${episode.title} - ${contentType}`);
        }
      } else {
        console.warn(`⚠️ [音頻測試] 後端代理測試失敗: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      console.log(`❌ [音頻測試] 後端代理測試失敗: ${episode.title} - ${error}`);
    }
    
    // 如果後端代理失敗，回退到前端代理測試（僅作為備用）
    console.log(`🌐 [音頻測試] 回退到前端代理測試...`);
    
    const corsProxies = [
      'https://corsproxy.io/?',
      // 移除失效的代理：cors.bridged.cc, proxy.cors.sh, cors-anywhere.herokuapp.com
    ];
    
    for (const proxy of corsProxies) {
      try {
        const testUrl = proxy + encodeURIComponent(episode.audioUrl);
        
        // 首先嘗試HEAD請求測試，避免下載整個文件
        let response: Response;
        try {
          response = await fetch(testUrl, {
            method: 'HEAD',
            signal: AbortSignal.timeout(8000), // 8秒超時
          });
        } catch (headError) {
          // 如果HEAD請求失敗，嘗試GET請求但只讀取少量數據
          console.log(`🔍 [音頻測試] HEAD請求失敗，嘗試部分GET: ${episode.title}`);
          response = await fetch(testUrl, {
            method: 'GET',
            headers: {
              'Range': 'bytes=0-1023' // 只請求前1KB數據
            },
            signal: AbortSignal.timeout(8000),
          });
        }
        
        if (response.ok || response.status === 206) { // 206是部分內容成功
          const contentType = response.headers.get('content-type') || '';
          const contentLength = response.headers.get('content-length');
          
          // 檢查是否為音頻文件
          const isAudioType = contentType.includes('audio') || 
                             contentType.includes('mp3') || 
                             contentType.includes('mp4') ||
                             contentType.includes('mpeg') ||
                             contentType.includes('m4a') ||
                             contentType.includes('wav') ||
                             contentType.includes('ogg');
          
          // 檢查文件大小（音頻文件通常比較大）
          const hasReasonableSize = !contentLength || parseInt(contentLength) > 10000; // 至少10KB
          
          if (isAudioType && hasReasonableSize) {
            console.log(`✅ [音頻測試] 前端代理測試成功: ${episode.title} (使用${proxy}) - ${contentType}`);
            return 'valid';
          } else {
            console.log(`⚠️ [音頻測試] 響應成功但不是音頻: ${episode.title} - ${contentType}, ${contentLength} bytes`);
          }
        }
      } catch (error) {
        console.log(`❌ [音頻測試] 前端代理測試失敗: ${episode.title} (${proxy}) - ${error}`);
        continue;
      }
    }
    
    console.log(`❌ [音頻測試] 所有方法都失敗: ${episode.title}`);
    return 'invalid';
  };

  // 新增：批量測試音頻鏈接
  const handleTestAllAudio = async () => {
    setTestingAudio(true);
    setAudioTestResults(new Map());
    
    console.log(`開始測試 ${episodes.length} 個音頻鏈接...`);
    
    const results = new Map<string, 'testing' | 'valid' | 'invalid'>();
    
    // 並行測試所有音頻（限制並發數量）
    const batchSize = 3; // 每次測試3個，避免請求過多
    
    for (let i = 0; i < episodes.length; i += batchSize) {
      const batch = episodes.slice(i, i + batchSize);
      
      // 設置為測試中狀態
      batch.forEach(episode => {
        results.set(episode.id, 'testing');
      });
      setAudioTestResults(new Map(results));
      
      // 並行測試這一批
      const batchPromises = batch.map(async (episode) => {
        const result = await testAudioUrl(episode);
        results.set(episode.id, result);
        setAudioTestResults(new Map(results)); // 實時更新結果
        return { episode, result };
      });
      
      await Promise.all(batchPromises);
      
      // 在批次間稍作延遲
      if (i + batchSize < episodes.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    setTestingAudio(false);
    
    // 統計結果
    const validCount = Array.from(results.values()).filter(r => r === 'valid').length;
    const invalidCount = Array.from(results.values()).filter(r => r === 'invalid').length;
    
    console.log(`音頻測試完成: ${validCount}個有效, ${invalidCount}個無效`);
    alert(`音頻鏈接測試完成！\n\n✅ 有效: ${validCount}個\n❌ 無效: ${invalidCount}個\n\n建議只選擇有效的音頻進行下載或轉錄。`);
  };

  // 新增：測試單個音頻
  const handleTestSingleAudio = async (episode: Episode) => {
    const results = new Map(audioTestResults);
    results.set(episode.id, 'testing');
    setAudioTestResults(results);
    
    const result = await testAudioUrl(episode);
    results.set(episode.id, result);
    setAudioTestResults(results);
    
    const message = result === 'valid' 
      ? `✅ "${episode.title}" 的音頻鏈接有效！` 
      : `❌ "${episode.title}" 的音頻鏈接無效或無法訪問。`;
    
    alert(message);
  };

  // 增強版轉錄功能
  const handleTranscribe = async (episode: Episode) => {
    if (!episode.audioUrl) {
      alert('此集數沒有音檔連結');
      return;
    }

    console.log(`開始增強轉錄: ${episode.title}`);
    console.log(`音檔 URL: ${episode.audioUrl}`);
    console.log('轉錄設置:', transcriptionSettings);

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
      
      // 2. 上傳到後端進行增強轉錄
      console.log('步驟 2: 開始上傳並進行增強轉錄...');
      setTranscriptProgress(prev => {
        const newMap = new Map(prev);
        newMap.set(episode.id, 30);
        return newMap;
      });
      
      const startTranscribe = Date.now();
      const transcript = await uploadForEnhancedTranscription(audioBlob, episode);
      const transcribeTime = Date.now() - startTranscribe;
      console.log(`增強轉錄完成，耗時: ${transcribeTime}ms`);
      
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
              transcriptFormats: transcript.formats,
              transcriptMetadata: transcript.metadata,
              transcriptUrl: transcript.url 
            }
          : ep
      ));

      console.log(`"${episode.title}" 增強轉錄完成！`);
      
      // 顯示完成訊息
      let successMessage = `"${episode.title}" 轉錄完成！`;
      
      if (transcript.metadata?.processed) {
        if (transcript.metadata.totalSegments > 1) {
          successMessage += `\n\n✨ 音檔已自動分割為 ${transcript.metadata.totalSegments} 個片段並完成轉錄`;
        } else {
          successMessage += `\n\n🎵 音檔已自動壓縮處理`;
        }
      }
      
      if (transcript.metadata?.speakerDiarization) {
        successMessage += `\n\n🎙️ 已啟用說話者分離功能`;
      }
      
      const formatCount = transcript.metadata?.outputFormats?.length || 1;
      successMessage += `\n\n📄 生成了 ${formatCount} 種格式的轉錄檔`;
      
      alert(successMessage);
    } catch (error) {
      console.error('增強轉錄失敗:', error);
      setEpisodes(prev => prev.map(ep => 
        ep.id === episode.id 
          ? { ...ep, transcriptStatus: 'error' }
          : ep
      ));
      
      // 錯誤處理
      const errorMessage = error instanceof Error ? error.message : '未知錯誤';
      
      if (errorMessage.includes('OpenAI API 額度不足')) {
        alert(`轉錄失敗 - API 額度不足\n\n${errorMessage}\n\n請檢查您的 OpenAI 帳戶餘額。`);
      } else if (errorMessage.includes('音檔格式不支援') || errorMessage.includes('檔案損壞')) {
        alert(`轉錄失敗 - 音檔格式問題\n\n${errorMessage}\n\n建議：請確保使用支援的音檔格式（MP3、WAV 等）。`);
      } else if (errorMessage.includes('音檔處理失敗')) {
        alert(`轉錄失敗 - 音檔處理錯誤\n\n${errorMessage}\n\n建議：請檢查音檔是否完整且格式正確。`);
      } else if (errorMessage.includes('代理下載失敗')) {
        alert(`轉錄失敗 - 無法下載音檔\n\n${errorMessage}\n\n建議：請檢查網絡連接或嘗試其他集數。`);
      } else {
        alert(`轉錄失敗：${errorMessage}`);
      }
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

  // 下載音檔用於轉錄（保持原有邏輯）
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

  // 新增：增強轉錄上傳函數
  const uploadForEnhancedTranscription = async (audioBlob: Blob, episode: Episode) => {
    console.log(`準備上傳音檔進行增強轉錄，檔案大小: ${(audioBlob.size / 1024 / 1024).toFixed(2)}MB`);
    
    // 更新進度：開始上傳
    setTranscriptProgress(prev => {
      const newMap = new Map(prev);
      newMap.set(episode.id, 40);
      return newMap;
    });
    
    const formData = new FormData();
    formData.append('audio', audioBlob, `${episode.title}.mp3`);
    formData.append('title', episode.title);
    formData.append('episodeId', episode.id);
    formData.append('outputFormats', transcriptionSettings.outputFormats.join(','));
    formData.append('contentType', transcriptionSettings.contentType);
    formData.append('enableSpeakerDiarization', transcriptionSettings.enableSpeakerDiarization.toString());

    console.log('開始上傳音檔到增強轉錄服務...');
    console.log('轉錄設置:', transcriptionSettings);
    
    // 更新進度：上傳中
    setTranscriptProgress(prev => {
      const newMap = new Map(prev);
      newMap.set(episode.id, 50);
      return newMap;
    });

    const uploadStartTime = Date.now();
    const response = await fetch('/api/transcribe', {
      method: 'POST',
      body: formData,
    });

    const uploadTime = Date.now() - uploadStartTime;
    console.log(`音檔上傳完成，耗時: ${uploadTime}ms`);

    // 更新進度：確認開始轉錄
    setTranscriptProgress(prev => {
      const newMap = new Map(prev);
      newMap.set(episode.id, 60);
      return newMap;
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('增強轉錄 API 錯誤:', errorText);
      
      // 嘗試解析錯誤回應
      let errorData: any = {};
      try {
        errorData = JSON.parse(errorText);
      } catch (parseError) {
        errorData = { error: errorText };
      }
      
      // 錯誤處理
      if (response.status === 402) {
        throw new Error('OpenAI API 額度不足，請檢查帳戶餘額');
      } else if (response.status === 400) {
        throw new Error('音檔格式不支援或檔案損壞，請嘗試使用 MP3 或 WAV 格式');
      } else {
        if (response.status === 413 && errorData.suggestions) { 
          const suggestionText = errorData.suggestions.map((s: string, i: number) => `${i + 1}. ${s}`).join("\n"); 
          const detailedMessage = [ 
            errorData.error || "檔案大小超過限制", 
            "", 
            `目前檔案大小：${errorData.currentSize || "未知"}`, 
            `最大限制：${errorData.maxSize || "25MB"}`, 
            "", 
            "💡 解決方案：", 
            suggestionText 
          ].join("\n"); 
          throw new Error(detailedMessage); 
        } else { 
          throw new Error(`增強轉錄服務錯誤 (${response.status}): ${errorData.error || errorText}`); 
        }
      }
    }

    console.log('✅ 增強轉錄服務已確認開始處理，正在等待結果...');
    
    // 更新進度：轉錄進行中
    setTranscriptProgress(prev => {
      const newMap = new Map(prev);
      newMap.set(episode.id, 70);
      return newMap;
    });

    const result = await response.json();
    console.log('增強轉錄結果接收完成:', result);
    
    // 更新進度：處理結果
    setTranscriptProgress(prev => {
      const newMap = new Map(prev);
      newMap.set(episode.id, 90);
      return newMap;
    });
    
    return result;
  };

  // 舊的上傳函數（保持兼容性）
  const uploadForTranscription = async (audioBlob: Blob, episode: Episode) => {
    return uploadForEnhancedTranscription(audioBlob, episode);
  };

  // 新增：下載特定格式的逐字稿
  const handleDownloadTranscript = (episode: Episode, format: string = 'txt') => {
    let content = '';
    let extension = 'txt';
    let mimeType = 'text/plain;charset=utf-8';

    if (episode.transcriptFormats && episode.transcriptFormats[format as keyof typeof episode.transcriptFormats]) {
      content = episode.transcriptFormats[format as keyof typeof episode.transcriptFormats] || '';
      extension = format;
      
      switch (format) {
        case 'srt':
          mimeType = 'text/srt;charset=utf-8';
          break;
        case 'vtt':
          mimeType = 'text/vtt;charset=utf-8';
          break;
        case 'json':
          mimeType = 'application/json;charset=utf-8';
          break;
        default:
          mimeType = 'text/plain;charset=utf-8';
      }
    } else if (episode.transcriptText) {
      // 回退到基本文字格式
      content = episode.transcriptText;
    } else {
      alert('此集數沒有逐字稿');
      return;
    }

    const blob = new Blob([content], { type: mimeType });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${episode.title}_逐字稿.${extension}`;
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
      // 更新的CORS代理列表 - 移除不工作的代理
      const corsProxies = [
        'https://corsproxy.io/?',
        // 移除失效的代理：cors.bridged.cc, proxy.cors.sh, cors-anywhere.herokuapp.com
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
      console.log('RSS feed 原始內容 (前 1000 字元):', text.substring(0, 1000));
      
      // 清理和修復 XML 內容
      let cleanedText = text;
      
      // 移除 BOM 和其他不可見字符
      cleanedText = cleanedText.replace(/^\uFEFF/, '');
      
      // 修復常見的 XML 問題
      cleanedText = cleanedText.replace(/&(?!amp;|lt;|gt;|quot;|apos;)/g, '&amp;');
      
      // 如果 XML 看起來不完整，嘗試修復
      if (!cleanedText.includes('<?xml') && !cleanedText.includes('<rss')) {
        console.log('檢測到不完整的 XML，嘗試修復...');
        // 如果內容看起來像是從中間開始的，嘗試添加 XML 頭部
        cleanedText = '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>' + cleanedText + '</channel></rss>';
      }
      
      console.log('清理後的 XML 內容 (前 1000 字元):', cleanedText.substring(0, 1000));
      
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(cleanedText, 'text/xml');
      
      const parseError = xmlDoc.querySelector('parsererror');
      if (parseError) {
        console.error('XML 解析錯誤:', parseError.textContent);
        console.log('嘗試使用 HTML 解析器...');
        
        // 如果 XML 解析失敗，嘗試使用 HTML 解析器
        const htmlDoc = parser.parseFromString(cleanedText, 'text/html');
        const items = htmlDoc.querySelectorAll('item');
        
        if (items.length === 0) {
          throw new Error('RSS feed 格式錯誤，無法解析');
        }
        
        console.log(`使用 HTML 解析器找到 ${items.length} 個 item 元素`);
        return parseItemsFromDocument(htmlDoc, items);
      }

      const items = xmlDoc.querySelectorAll('item');
      console.log(`找到 ${items.length} 個 item 元素`);
      
      if (items.length === 0) {
        throw new Error('RSS feed 中沒有找到任何集數');
      }

      return parseItemsFromDocument(xmlDoc, items);
      
    } catch (error) {
      console.error('解析 RSS feed 時發生錯誤:', error);
      alert(`解析 RSS feed 失敗：${error instanceof Error ? error.message : '未知錯誤'}\n\n請確認連結是否正確，或稍後再試。`);
    }
  };

  // 從文檔中解析 item 元素
  const parseItemsFromDocument = (doc: Document, items: NodeListOf<Element>) => {
    const parsedEpisodes: Episode[] = Array.from(items).map((item, index) => {
      // 提取標題 - 處理 CDATA
      const titleElement = item.querySelector('title');
      let title = titleElement?.textContent || `EP${index + 1}`;
      
      // 清理 CDATA 標記和其他特殊字符
      title = title.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
      title = title.replace(/\s+/g, ' ').trim();
      
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
        transcriptStatus: 'none' as const,
      };
    });
    
    setEpisodes(parsedEpisodes);
    console.log(`成功解析 ${parsedEpisodes.length} 個集數`);
    
    // 檢查有多少集數有音檔連結
    const episodesWithAudio = parsedEpisodes.filter(ep => ep.audioUrl);
    console.log(`其中 ${episodesWithAudio.length} 個集數有音檔連結`);
    
    if (episodesWithAudio.length === 0) {
      alert('警告：解析成功但沒有找到任何音檔連結。這可能是因為該 Podcast 平台使用了特殊的音檔保護機制。');
    } else {
      alert(`成功載入 ${parsedEpisodes.length} 個集數，其中 ${episodesWithAudio.length} 個有音檔連結！`);
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
    
    // 更新的CORS代理列表 - 與其他功能保持一致
    const corsProxies = [
      'https://corsproxy.io/?',
      'https://cors.bridged.cc/',
      'https://proxy.cors.sh/',
      'https://cors-anywhere.herokuapp.com/',
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
      
      // 如果直接下載失敗，嘗試使用代理
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

    // 根據進度顯示不同的狀態文字
    const getProgressText = (progress: number) => {
      if (progress <= 10) return '準備中...';
      if (progress <= 30) return '下載音檔...';
      if (progress <= 40) return '準備上傳...';
      if (progress <= 50) return '上傳音檔...';
      if (progress <= 60) return '開始轉錄...';
      if (progress <= 70) return '🎵 音檔處理中...';
      if (progress <= 80) return '🎤 轉錄進行中...';
      if (progress <= 90) return '📝 處理結果...';
      return '即將完成...';
    };

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
              {getProgressText(progress)} ({progress}%)
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
        <h1>🎙️ 2026Podcast批量下載與增強轉錄工具</h1>
        <p>輸入 RSS feed 連結，批量下載 podcast 集數並生成多格式逐字稿</p>
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
            🎤 增強轉錄功能：支援多種格式輸出、說話者分離、智能分段優化
          </p>
        </div>

        {/* 新增：轉錄設置面板 */}
        <div className="transcription-settings-section">
          <div className="settings-header">
            <h3>🔧 轉錄設置</h3>
            <button 
              onClick={() => setShowTranscriptionSettings(!showTranscriptionSettings)}
              className="toggle-settings-button"
            >
              {showTranscriptionSettings ? '隱藏設置' : '顯示設置'}
            </button>
          </div>
          
          {showTranscriptionSettings && (
            <div className="settings-panel">
              <div className="setting-group">
                <label>📄 輸出格式：</label>
                <div className="format-options">
                  {['txt', 'srt', 'vtt', 'json'].map(format => (
                    <label key={format} className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={transcriptionSettings.outputFormats.includes(format)}
                        onChange={(e) => {
                          const formats = e.target.checked
                            ? [...transcriptionSettings.outputFormats, format]
                            : transcriptionSettings.outputFormats.filter(f => f !== format);
                          updateTranscriptionSettings('outputFormats', formats);
                        }}
                      />
                      <span className="format-label">
                        {format.toUpperCase()}
                        {format === 'txt' && ' (純文字)'}
                        {format === 'srt' && ' (字幕)'}
                        {format === 'vtt' && ' (網頁字幕)'}
                        {format === 'json' && ' (結構化數據)'}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="setting-group">
                <label>🎯 內容類型：</label>
                <select 
                  value={transcriptionSettings.contentType}
                  onChange={(e) => updateTranscriptionSettings('contentType', e.target.value)}
                  className="content-type-select"
                >
                  <option value="podcast">🎙️ 播客節目</option>
                  <option value="interview">🗣️ 訪談節目</option>
                  <option value="lecture">📚 講座/教學</option>
                </select>
              </div>

              <div className="setting-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={transcriptionSettings.enableSpeakerDiarization}
                    onChange={(e) => updateTranscriptionSettings('enableSpeakerDiarization', e.target.checked)}
                  />
                  <span>🎤 啟用說話者分離 (實驗性功能)</span>
                </label>
                <small className="setting-description">
                  自動識別和標記不同的說話者，適用於對話類內容
                </small>
              </div>

              <div className="settings-summary">
                <strong>目前設置：</strong>
                <span>格式: {transcriptionSettings.outputFormats.join(', ').toUpperCase()}</span>
                <span>類型: {
                  transcriptionSettings.contentType === 'podcast' ? '播客節目' :
                  transcriptionSettings.contentType === 'interview' ? '訪談節目' : '講座/教學'
                }</span>
                <span>說話者分離: {transcriptionSettings.enableSpeakerDiarization ? '啟用' : '停用'}</span>
              </div>
            </div>
          )}
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
                  {downloading ? '下載中...' : `📥 批量下載 (${selected.length})`}
                </button>
                
                <button
                  onClick={handleBatchTranscribe}
                  disabled={selected.length === 0}
                  className="transcribe-button transcribe-button-override"
                >
                  🎤 批量轉錄 ({selected.length})
                </button>
                
                <button
                  onClick={handleTestAllAudio}
                  disabled={testingAudio || episodes.length === 0}
                  className="test-button"
                  title="測試所有音頻鏈接的有效性"
                >
                  {testingAudio ? '🔍 測試中...' : '🔍 測試音頻'}
                </button>
                
                <button
                  onClick={() => {
                    const validIds = episodes
                      .filter(ep => audioTestResults.get(ep.id) === 'valid')
                      .map(ep => ep.id);
                    setSelected(validIds);
                  }}
                  disabled={audioTestResults.size === 0}
                  className="select-valid-button"
                  title="選擇所有有效的音頻"
                >
                  ✅ 選擇有效音頻
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
                    <th>播放器</th>
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
                      <td>{formatDuration(episode.duration)}</td>
                      <td className="audio-url">
                        {episode.audioUrl ? (
                          <div className="audio-link-container">
                            <div className="audio-link-main">
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
                            
                            {/* 音頻測試結果指示器 */}
                            <div className="audio-test-status">
                              {audioTestResults.get(episode.id) === 'testing' && (
                                <span className="test-status testing" title="測試中...">
                                  🔍 測試中
                                </span>
                              )}
                              {audioTestResults.get(episode.id) === 'valid' && (
                                <span className="test-status valid" title="音頻鏈接有效">
                                  ✅ 有效
                                </span>
                              )}
                              {audioTestResults.get(episode.id) === 'invalid' && (
                                <span className="test-status invalid" title="音頻鏈接無效">
                                  ❌ 無效
                                </span>
                              )}
                              {!audioTestResults.has(episode.id) && (
                                <button
                                  onClick={() => handleTestSingleAudio(episode)}
                                  className="test-single-button"
                                  title="測試此音頻鏈接"
                                >
                                  🔍 測試
                                </button>
                              )}
                            </div>
                          </div>
                        ) : (
                          <span className="no-link">無連結</span>
                        )}
                      </td>
                      <td className="audio-player-cell">
                        {episode.audioUrl && (
                          <AudioPlayer
                            episode={episode}
                            isPlaying={currentlyPlaying === episode.id}
                            onTogglePlay={() => handleTogglePlay(episode.id)}
                          />
                        )}
                      </td>
                      <td>
                        <div className="transcript-status-container">
                          {renderTranscriptStatus(episode)}
                          {episode.transcriptMetadata && (
                            <div className="transcript-metadata">
                              {episode.transcriptMetadata.speakerDiarization && (
                                <span className="metadata-tag speaker-tag">🎤 說話者</span>
                              )}
                              {episode.transcriptMetadata.totalSegments && episode.transcriptMetadata.totalSegments > 1 && (
                                <span className="metadata-tag segments-tag">
                                  ✂️ {episode.transcriptMetadata.totalSegments}片段
                                </span>
                              )}
                              {episode.transcriptMetadata.outputFormats && (
                                <span className="metadata-tag formats-tag">
                                  📄 {episode.transcriptMetadata.outputFormats.length}格式
                                </span>
                              )}
                            </div>
                          )}
                        </div>
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
                          
                          {episode.transcriptStatus === 'completed' && episode.transcriptFormats && (
                            <div className="download-options">
                              {Object.keys(episode.transcriptFormats).map(format => 
                                episode.transcriptFormats![format as keyof typeof episode.transcriptFormats] && (
                                  <button
                                    key={format}
                                    onClick={() => handleDownloadTranscript(episode, format)}
                                    className={`action-button download-transcript-button format-${format}`}
                                    title={`下載 ${format.toUpperCase()} 格式`}
                                  >
                                    📄 {format.toUpperCase()}
                                  </button>
                                )
                              )}
                            </div>
                          )}

                          {/* 回退選項：如果沒有多格式，使用原始下載 */}
                          {episode.transcriptStatus === 'completed' && !episode.transcriptFormats && (
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