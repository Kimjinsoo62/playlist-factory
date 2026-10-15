// 로컬 폴더 어댑터: input/ 안의 오디오 파일을 트랙으로 사용 (treblo.com 웹에서 직접 만든 곡, 또는 테스트용)
import fs from 'node:fs';
import path from 'node:path';

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.wav', '.flac', '.ogg', '.aac']);

export class LocalProvider {
  constructor(inputDir) { this.inputDir = inputDir; }

  listFiles() {
    if (!fs.existsSync(this.inputDir)) return [];
    return fs.readdirSync(this.inputDir)
      .filter(f => AUDIO_EXT.has(path.extname(f).toLowerCase()))
      .sort((a, b) => a.localeCompare(b, 'ko'))
      .map(f => path.join(this.inputDir, f));
  }

  /** 파일명에서 제목 추출: "01 - 제목.mp3" → "제목" */
  static titleFromFile(file) {
    return path.basename(file, path.extname(file)).replace(/^\d+\s*[-_.]\s*/, '').trim() || path.basename(file);
  }

  /** 같은 이름의 .txt 또는 .lrc 가 있으면 가사로 사용 */
  static lyricsForFile(file) {
    const base = file.slice(0, -path.extname(file).length);
    for (const ext of ['.txt', '.lrc']) {
      if (fs.existsSync(base + ext)) return fs.readFileSync(base + ext, 'utf8');
    }
    return '';
  }
}
