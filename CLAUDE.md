# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트

플레이리스트 팩토리: 장르 프리셋 → AI 작곡(Treblo / Google Lyria) → 정규화·결합 → 가사 자막(ASS) → 배경 사진·썸네일 → 1080p 렌더링 → 유튜브 제목·설명·챕터까지 자동으로 만드는 로컬 웹앱. Node 18+ ESM(`"type": "module"`), Express 5, Python(Pillow), ffmpeg. 코드 주석·로그·UI·커밋 메시지는 모두 한국어다.

## 명령

린트·단위 테스트 러너는 없다. 유일한 자동 검증은 아래 mock 파이프라인이다.

```bat
START.bat                       :: 서버 실행 + 브라우저 열기 (node_modules 없으면 install.bat 자동 호출, 포트는 config.json)
install.bat                     :: npm install + Pillow + ffmpeg 확인
STOP.bat                        :: 비상 종료 (종료 API 호출 → 실패 시 이 프로젝트 경로의 프로세스만 직접 정리)
```

```bash
npm start                                   # = node server/index.js (0.0.0.0:5177)
npm run mcp                                 # MCP stdio 서버. 웹 서버가 먼저 떠 있어야 함 (PLAYLIST_FACTORY_URL 로 주소 변경)
npm run test:mock                           # 합성음 3곡으로 9단계 전체 검증 (API 호출·크레딧 없음, ffmpeg·Pillow 필요)
node scripts/test-mock.js lofi-study 2 10   # <프리셋id> <곡수> <곡당 초>. BG=gradient|photo|slideshow 환경변수로 배경 모드
node scripts/fetch-backgrounds.js 3 jazz-night   # 프리셋별 배경 사진 풀 미리 채우기 [장수] [프리셋id ...]
python scripts/contact-sheet.py out.jpg     # 배경 풀 전체를 한 장으로 모아 보기
```

결과물은 `output/<jobId>/` (playlist.mp4, playlist.mp3, thumbnail.jpg, subs.ass, youtube.txt, job.json, job.log).

## 구조

### 요청 흐름

`public/app.js` (바닐라 JS, 빌드 없음) → `server/index.js` REST → `jobs.js`의 `createJob` → `pipeline.js`의 `runJob` (setImmediate로 비동기 실행) → 진행 상황은 `jobs.js`의 `bus` EventEmitter → `GET /api/events` SSE → 메인 창과 별도 로그 창(`public/log.html`).

- 작업 상태는 메모리 Map + `output/<id>/job.json`(summarize) + `job.log`에 영속. 서버 재시작 시 `loadPastJobs`가 job.json을 다시 읽고, running/queued였던 작업은 failed로 바꾼다. 로그는 디스크의 job.log에서 복원.
- 라우트 묶음: `/api/presets*` (CRUD·복제·LLM 생성), `/api/keys*` (키 저장·활성/대기·연결 확인·모델 목록), `/api/jobs*`, `/api/plan`, `/api/backgrounds*`, `/api/update/*`, `/api/shutdown`.

### 파이프라인 9단계 (`server/pipeline.js`)

계획(한글 요청 → LLM 영어 번역) → 곡 생성/수집 → 라우드니스 정규화 → 결합 → ASS 자막 → 배경 사진·썸네일(`scripts/thumbnail.py`) → ffmpeg 렌더링(슬라이드쇼 배경 선택) → 유튜브 메타(`youtube.js`) → mp3·정리. `planTracks`가 프리셋+언어+곡 수를 생성 스펙으로 바꾸며 `/api/plan`(비용 견적)과 공유된다.

### 음원 소스 (`server/providers/`)

| provider | 특징 |
|---|---|
| `treblo` | 보컬·연주곡 모두. 단어별 정렬(`extractAlignment`)을 받아 박자 맞는 자막을 만든다. 태그는 `presets/_treblo-tags.txt` 사전으로 검증 |
| `lyria` | **연주곡 전용**. 가사 타이밍을 주지 않아 서버가 보컬 요청을 거부한다 (index.js와 pipeline.js 양쪽에서 검사) |
| `local` | `input/` 폴더의 오디오 파일(mp3·m4a·wav·flac·ogg·aac). 같은 이름의 `.txt` 또는 `.lrc`가 있으면 가사로 사용, 파일명 앞 번호("01 - 제목")는 제목에서 제거 |
| `mock` | pipeline.js 안에 인라인(`ff.synthTrack`). `dryRun: true`와 같음 |

작곡 AI는 한 번에 하나만 활성(`config.provider`). 대기 상태 소스로는 작업 생성이 거부된다.

### LLM 층 (`server/llm.js`)

Claude·OpenAI·Gemini를 `chat()` 한 함수(system + user → JSON 텍스트)로 추상화. `config.llm.provider`가 메인 제공자, 제공자마다 `model`(품질: 프리셋 생성)과 `cheapModel`(작업마다: 번역·배경 검색어 기획·후보 선별)을 둔다. Gemini 키가 비어 있으면 Lyria 키를 공유한다. LLM 키가 없어도 파이프라인은 돌아가며 번역·기획 단계만 건너뛴다.

### 설정 (`server/config.js`)

`DEFAULTS`에 `config.json`을 deepMerge하고 환경변수(`TREBLO_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `PORT`)로 덮어쓴다. `saveConfig`는 **파일 내용**을 기준으로 병합한다. 환경변수로 들어온 키가 파일에 기록되지 않게 하려는 의도이므로 단순화하지 말 것. API 응답에는 항상 `maskConfig`를 거친다.

### 프리셋 (`presets/*.json`)

허용 필드는 index.js의 `PRESET_FIELDS`. id는 `^[a-z0-9][a-z0-9-]{1,40}$`, `negative_tags`/`tags`는 Treblo 태그 사전에 있어야 하고, `length_range`는 30의 배수 두 개. `topics`는 언어별(ko/en/ja) 배열이며, en/ja에 한글 주제만 있으면 `DEFAULT_TOPICS`로 대체된다. 새 프리셋 저장 시 영어 프롬프트가 비어 있으면 메인 LLM이 자동 생성한다.

### 배경 사진 (`server/images.js`)

Wikimedia Commons(기본) / Openverse / Pexels에서 상업 이용 가능 라이선스(CC0·PD·CC BY·Pexels)만 수집. 프리셋별 풀 `assets/backgrounds/<preset>/`(jpg + 출처 json)는 git 제외, `_rejected.txt`만 공유. CC BY 출처는 유튜브 설명에 자동 기재.

### 자식 프로세스

ffmpeg·ffprobe·python은 모두 `media/ffmpeg.js`의 `children` Set을 거친다. `shutdown.js`가 이 Set으로 작업 프로세스를 죽이므로 새 spawn도 같은 경로를 쓸 것. `runPython`은 `-X utf8`을 붙여 호출한다.

### 전역 11개 기본 기능의 위치

[종료] → `server/shutdown.js` (캐시 → 자식 프로세스 → 포트 → 이 경로의 cmd 창 → 앱 제목의 브라우저 창). [업데이트] → `server/update.js` (fetch → 커밋 목록 → `pull --ff-only`, package.json 변경 시 install 안내). LAN 주소 → `server/lan.js`, `/api/info`. 설명서 → `사용설명서.html`을 `/manual`로 서빙. 기능이 바뀌면 설명서를 같이 고친다.

### MCP (`mcp/server.js`)

실행 중인 웹 서버의 REST를 호출하는 얇은 클라이언트. 도구: list_presets, plan_playlist, create_playlist, get_job, wait_job, list_jobs, get_youtube_text, credits. 파이프라인 로직은 넣지 않는다.

## 주의

- **treblo·lyria 소스로 작업을 시작하면 실제 과금된다** (Treblo 곡당 100크레딧, Lyria 곡당 약 $0.08). 검증은 항상 `mock`(`dryRun`) 또는 `npm run test:mock`으로 한다. 활성 소스로 `POST /api/jobs`를 테스트 삼아 보내지 말 것.
- **배치 파일은 CP949(ANSI) + CRLF**다 (`.gitattributes`). UTF-8로 다시 저장하면 cmd가 한글 줄 뒤 명령을 잘라먹는다. 읽을 때는 `iconv -f cp949 -t utf-8`, 고칠 때는 UTF-8로 편집한 뒤 `iconv -t cp949`로 되돌려 쓰거나 PowerShell에서 `-Encoding Default`로 저장한다.
- `config.json`은 git 제외이며 실제 API 키가 들어 있다. 내용을 확인할 때는 `cat`하지 말고 `GET /api/config`(마스킹) 또는 키 필드를 제외하고 본다.
- 이 셸에서 파이프로 받은 한글은 깨져 보일 수 있다. Python 출력은 `python -I -X utf8`로 확인한다. 깨짐은 표시 문제일 뿐 앱 버그가 아니다.
- Express 5라서 와일드카드·경로 문법이 v4와 다르다.
- 제외 태그·주제·검색어 등 데이터는 코드가 아니라 프리셋 JSON에 둔다. 최근 커밋 대부분이 프리셋 추가·수정이다.
