const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

/**
 * 增強轉錄服務模塊
 * 支援多種輸出格式、說話者分離等功能
 */

// 轉錄格式處理器
class TranscriptionFormatter {
  
  /**
   * 生成 SRT 字幕格式
   */
  static generateSRT(transcription) {
    if (!transcription.segments || transcription.segments.length === 0) {
      return this.generatePlainSRT(transcription.text, transcription.duration);
    }

    let srt = '';
    transcription.segments.forEach((segment, index) => {
      const startTime = this.formatSRTTime(segment.start);
      const endTime = this.formatSRTTime(segment.end);
      
      srt += `${index + 1}\n`;
      srt += `${startTime} --> ${endTime}\n`;
      srt += `${segment.text.trim()}\n\n`;
    });

    return srt;
  }

  /**
   * 生成 VTT 字幕格式
   */
  static generateVTT(transcription) {
    let vtt = 'WEBVTT\n\n';
    
    if (!transcription.segments || transcription.segments.length === 0) {
      vtt += this.generatePlainVTT(transcription.text, transcription.duration);
      return vtt;
    }

    transcription.segments.forEach((segment, index) => {
      const startTime = this.formatVTTTime(segment.start);
      const endTime = this.formatVTTTime(segment.end);
      
      vtt += `${startTime} --> ${endTime}\n`;
      vtt += `${segment.text.trim()}\n\n`;
    });

    return vtt;
  }

  /**
   * 生成 JSON 格式（包含詳細時間戳）
   */
  static generateJSON(transcription) {
    return JSON.stringify({
      text: transcription.text,
      language: transcription.language,
      duration: transcription.duration,
      segments: transcription.segments?.map(segment => ({
        id: segment.id || uuidv4(),
        text: segment.text.trim(),
        start: segment.start,
        end: segment.end,
        words: segment.words || []
      })) || [],
      metadata: {
        model: 'whisper-1',
        timestamp: new Date().toISOString(),
        processed: transcription.processed || false,
        totalSegments: transcription.totalSegments || 1
      }
    }, null, 2);
  }

  /**
   * 生成純文字格式（帶時間戳）
   */
  static generatePlainText(transcription) {
    if (!transcription.segments || transcription.segments.length === 0) {
      return transcription.text || '';
    }

    return transcription.segments
      .map(segment => {
        const startTime = this.formatTime(segment.start);
        const endTime = this.formatTime(segment.end);
        return `[${startTime} - ${endTime}] ${segment.text.trim()}`;
      })
      .join('\n\n');
  }

  /**
   * 生成帶說話者標籤的格式（為說話者分離準備）
   */
  static generateSpeakerText(transcription, speakers = null) {
    if (!transcription.segments || transcription.segments.length === 0) {
      return transcription.text || '';
    }

    return transcription.segments
      .map((segment, index) => {
        const startTime = this.formatTime(segment.start);
        const endTime = this.formatTime(segment.end);
        const speaker = speakers ? speakers[index] || 'Speaker 1' : 'Speaker 1';
        return `[${startTime} - ${endTime}] ${speaker}: ${segment.text.trim()}`;
      })
      .join('\n\n');
  }

  // 時間格式化輔助函數
  static formatSRTTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
  }

  static formatVTTTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
  }

  static formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
  }

  // 當沒有詳細時間戳時的回退方法
  static generatePlainSRT(text, duration) {
    const startTime = this.formatSRTTime(0);
    const endTime = this.formatSRTTime(duration || 60);
    
    return `1\n${startTime} --> ${endTime}\n${text}\n\n`;
  }

  static generatePlainVTT(text, duration) {
    const startTime = this.formatVTTTime(0);
    const endTime = this.formatVTTTime(duration || 60);
    
    return `${startTime} --> ${endTime}\n${text}\n\n`;
  }
}

// 轉錄品質優化器
class TranscriptionOptimizer {
  
  /**
   * 優化轉錄提示詞（針對不同語言和內容類型）
   */
  static generateOptimizedPrompt(language = 'zh', contentType = 'podcast') {
    const prompts = {
      zh: {
        podcast: '請使用繁體中文進行轉錄。這是一個播客節目，請保持自然的對話語調，適當添加標點符號，並保持語境的連貫性。',
        interview: '請使用繁體中文進行轉錄。這是一個訪談節目，請區分主持人和來賓的發言，保持正式的語調。',
        lecture: '請使用繁體中文進行轉錄。這是一個講座或教學內容，請使用學術性的語言，正確轉錄專業術語。'
      },
      en: {
        podcast: 'Please transcribe this podcast in natural conversational English with proper punctuation and context.',
        interview: 'Please transcribe this interview maintaining formal tone and distinguishing between speakers.',
        lecture: 'Please transcribe this lecture using academic language and technical terminology.'
      }
    };

    return prompts[language]?.[contentType] || prompts.zh.podcast;
  }

  /**
   * 智能分段處理
   */
  static intelligentSegmentation(segments) {
    if (!segments || segments.length === 0) return segments;

    const optimizedSegments = [];
    let currentSegment = null;

    segments.forEach(segment => {
      const text = segment.text.trim();
      
      // 跳過空白或極短的片段
      if (text.length < 2) return;

      // 如果當前片段太短（<3秒）且不是句子結尾，嘗試合併
      if (currentSegment && 
          (segment.start - currentSegment.end) < 1 && // 間隔小於1秒
          currentSegment.text.length < 100 && // 當前片段不太長
          !this.isSentenceEnd(currentSegment.text)) {
        
        currentSegment.text += ' ' + text;
        currentSegment.end = segment.end;
        currentSegment.words = [...(currentSegment.words || []), ...(segment.words || [])];
      } else {
        if (currentSegment) {
          optimizedSegments.push(currentSegment);
        }
        currentSegment = { ...segment, text };
      }
    });

    if (currentSegment) {
      optimizedSegments.push(currentSegment);
    }

    return optimizedSegments;
  }

  /**
   * 判斷是否為句子結尾
   */
  static isSentenceEnd(text) {
    return /[。！？\.!?]$/.test(text.trim());
  }

  /**
   * 文字後處理（修正常見錯誤）
   */
  static postProcessText(text) {
    return text
      // 修正常見的中文轉錄錯誤
      .replace(/那個那個/g, '那個')
      .replace(/就是就是/g, '就是')
      .replace(/然後然後/g, '然後')
      // 修正標點符號
      .replace(/，，/g, '，')
      .replace(/。。/g, '。')
      // 移除多餘空格
      .replace(/\s+/g, ' ')
      .trim();
  }
}

// 說話者分離準備（將來擴展）
class SpeakerDiarization {
  
  /**
   * 模擬說話者分離（基於音頻特徵分析）
   * 目前使用簡單的時間間隔和音量變化來估計說話者切換
   */
  static async simulateSpeakerDetection(segments) {
    if (!segments || segments.length === 0) return segments;

    const speakerSegments = [];
    let currentSpeaker = 'Speaker 1';
    let speakerCount = 1;

    segments.forEach((segment, index) => {
      const prevSegment = index > 0 ? segments[index - 1] : null;
      
      // 簡單的說話者切換檢測邏輯
      // 基於：時間間隔、音調變化（模擬）
      if (prevSegment) {
        const gap = segment.start - prevSegment.end;
        const textLengthDiff = Math.abs(segment.text.length - prevSegment.text.length);
        
        // 如果間隔較長或文字風格變化較大，可能是不同說話者
        if (gap > 3 || textLengthDiff > 50) {
          // 隨機決定是否切換說話者（模擬真實的說話者檢測）
          if (Math.random() > 0.7) {
            speakerCount = Math.min(speakerCount + 1, 4); // 最多4個說話者
            currentSpeaker = `Speaker ${speakerCount}`;
          }
        }
      }

      speakerSegments.push({
        ...segment,
        speaker: currentSpeaker
      });
    });

    return speakerSegments;
  }

  /**
   * 為將來的真實說話者分離準備 API 接口
   */
  static async performRealSpeakerDiarization(audioPath) {
    // 這裡將來可以整合 pyannote.audio 或其他說話者分離服務
    // 目前返回模擬結果
    console.log('說話者分離功能正在開發中，目前使用模擬結果');
    return null;
  }
}

// 轉錄結果處理器
class TranscriptionProcessor {
  
  /**
   * 處理轉錄結果，生成多種格式
   */
  static processTranscriptionResult(transcription, options = {}) {
    const {
      enableSpeakerDiarization = false,
      outputFormats = ['txt'],
      optimizeSegments = true,
      contentType = 'podcast'
    } = options;

    // 優化分段
    if (optimizeSegments && transcription.segments) {
      transcription.segments = TranscriptionOptimizer.intelligentSegmentation(transcription.segments);
    }

    // 後處理文字
    if (transcription.text) {
      transcription.text = TranscriptionOptimizer.postProcessText(transcription.text);
    }

    // 生成多種格式
    const results = {
      original: transcription,
      formats: {}
    };

    outputFormats.forEach(format => {
      switch (format) {
        case 'srt':
          results.formats.srt = TranscriptionFormatter.generateSRT(transcription);
          break;
        case 'vtt':
          results.formats.vtt = TranscriptionFormatter.generateVTT(transcription);
          break;
        case 'json':
          results.formats.json = TranscriptionFormatter.generateJSON(transcription);
          break;
        case 'txt':
        default:
          results.formats.txt = TranscriptionFormatter.generatePlainText(transcription);
          break;
      }
    });

    return results;
  }
}

module.exports = {
  TranscriptionFormatter,
  TranscriptionOptimizer,
  SpeakerDiarization,
  TranscriptionProcessor
}; 