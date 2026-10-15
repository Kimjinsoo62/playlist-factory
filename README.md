# 플레이리스트 팩토리

장르 프리셋을 고르고 곡 수와 언어를 정하면 AI 음악 생성(Treblo API) → 결합 → 가사 자막 → 썸네일 → 1080p 영상 → 유튜브 제목·설명·챕터까지 자동으로 만드는 로컬 웹앱. Claude에서 MCP로 "플레이리스트 만들어 줘" 한마디로도 실행된다.

- 실행: `START.bat` (의존성 없으면 `install.bat` 자동 호출)
- 비상 종료: `STOP.bat`
- 설명서: `사용설명서.html` (앱 상단 [설명서] 버튼)
- 음악 생성: [Treblo](https://treblo.com) (구 Sonauto) 공개 API. 곡당 100크레딧. *Powered by Treblo*
- 음원 소스 3종: Treblo API 자동 생성 / `input/` 로컬 파일 / 테스트 합성음(크레딧 0)

## 구조

```
server/            Express 서버 (API, SSE 진행 상황, 종료·업데이트)
  pipeline.js      9단계 파이프라인
  providers/       treblo.js (API 어댑터), local.js (input 폴더)
  media/           ffmpeg.js (정규화·결합·렌더링), subtitles.js (ASS)
  youtube.js       제목·설명·챕터
mcp/server.js      MCP 서버 (Claude 연동)
presets/*.json     장르 프리셋
scripts/thumbnail.py  배경·썸네일 (Pillow)
public/            UI (8pt, 1920×1080 기준)
```

## 테스트

```
npm run test:mock            # 합성음 3곡으로 전체 파이프라인 검증 (API 호출 없음)
node scripts/test-mock.js lofi-study 2 10
```
