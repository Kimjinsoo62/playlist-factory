# 플레이리스트 팩토리

장르 프리셋을 고르고 곡 수와 언어를 정하면 AI 음악 생성(Treblo API) → 결합 → 가사 자막 → 썸네일 → 1080p 영상 → 유튜브 제목·설명·챕터까지 자동으로 만드는 로컬 웹앱. Claude에서 MCP로 "플레이리스트 만들어 줘" 한마디로도 실행된다.

- GitHub: https://github.com/Kimjinsoo62/playlist-factory

## 설치

필요한 프로그램 (Windows 10/11 기준)

| 프로그램 | 버전 | 설치 |
|---|---|---|
| Node.js | 18 이상 (LTS 권장) | https://nodejs.org |
| Python | 3.10 이상, PATH 등록 | https://www.python.org (Pillow는 install.bat이 설치) |
| ffmpeg | 최신 essentials 빌드, PATH 등록 | `winget install Gyan.FFmpeg` 또는 https://www.gyan.dev/ffmpeg/builds/ |
| Git | 아무 버전 | https://git-scm.com ([업데이트] 버튼이 사용) |

설치 순서

```bat
git clone https://github.com/Kimjinsoo62/playlist-factory.git
cd playlist-factory
install.bat
START.bat
```

1. `install.bat`: Node 패키지(express, MCP SDK)와 Pillow를 설치하고 ffmpeg 유무를 확인한다.
2. `START.bat`: 서버를 띄우고 브라우저를 연다. 의존성이 없으면 install.bat을 자동으로 호출한다. 콘솔에 LAN 주소가 표시되어 같은 네트워크의 다른 PC에서도 접속할 수 있다.
3. 앱 상단 **[설정]** 버튼을 눌러 작곡 AI API 키 모달에서 Treblo API 키를 등록한다(Lyria·Mureka 키도 같은 곳). 키는 https://treblo.com/developers 에서 발급하며 `config.json`에만 저장된다(git 제외). 모달에서 키 확인·삭제, 모델, 동시 생성 수를 관리한다. 키가 둘 다 있으면 **● 활성화 / ○ 대기** 버튼으로 하나만 활성으로 쓴다(활성 소스 = `config.provider`, 대기 소스는 소스 목록에서 선택 불가·작업 거부).
4. 소스를 "테스트(합성음)"로 두고 **▶ 자동 생성 시작**을 눌러 전체 과정을 먼저 확인한 뒤, "Treblo API"로 바꿔 실제 곡을 만든다.

업데이트는 앱 상단 **[업데이트]** 버튼(git fetch → 승인 → git pull) 또는 `git pull`로 한다. package.json이 바뀌면 install.bat을 다시 실행한다.

### Treblo API 비용

곡당 100크레딧. 무료 체험 3,000크레딧(약 30곡, 카드 등록 필요), 이후 Starter $11/월(200곡) 또는 종량제. API로 만든 곡은 API 약관에 따라 사용자가 소유하며 상업 이용·수익화가 가능하다. 앱에는 API 약관이 요구하는 "Powered by Treblo" 표기가 들어 있다.

- 실행: `START.bat` (의존성 없으면 `install.bat` 자동 호출)
- 비상 종료: `STOP.bat`
- 설명서: `사용설명서.html` (앱 상단 [설명서] 버튼)
- 음악 생성: [Treblo](https://treblo.com) (구 Sonauto) 공개 API. 곡당 100크레딧. *Powered by Treblo*
- 음원 소스 5종: Treblo API 자동 생성 / Google Lyria 자동 생성(연주곡 전용) / Mureka API 자동 생성(보컬·연주곡, 가사 타이밍) / `input/` 로컬 파일 / 테스트 합성음(크레딧 0)
- 배경 사진 자동 수집: Wikimedia Commons(Unsplash 출처 CC0 우선, 키 불필요) / Openverse / Pexels(키). `assets/backgrounds/`에 풀로 저장, `_rejected.txt`로 제외 관리
- 배경 영상(무료·상업 이용 가능): 슬라이드쇼 [설정] 모달에서 사진만 / 사진·영상 섞기 / 영상만 선택. Pexels Videos 또는 Pixabay Videos(둘 다 무료 API 키 필요)에서 클립을 받아 1920×1080·무음·12초로 정규화해 `assets/backgrounds/<preset>/videos/`에 저장(`server/videos.js`, `scripts/fetch-videos.js`). 영상이 들어가면 24fps 로 렌더링, 출처는 유튜브 설명에 "Background videos:"로 기재
  - 상업적 이용 가능 라이선스만(CC0·퍼블릭 도메인·CC BY·Pexels). NC/ND/SA·사용 제한 파일 제외, CC BY 출처는 유튜브 설명에 자동 기재
  - 메인 LLM 키가 있으면 작업마다 곡 제목·가사로 검색어를 기획하고 후보(풀 + 새 검색)를 분위기 기준으로 선별
- 메인 LLM: Claude · OpenAI · Gemini 중 하나를 상단 [설정] 모달에서 키 등록 후 "● 메인으로" 지정(`llm.provider`). 한글 요청(상세 설명·추가 프롬프트) → 영어 번역, 새 프리셋 생성, 배경 사진 기획·선별에 사용. 카드마다 모델(품질)·경량 모델(작업마다) id 를 자유 입력하며 "모델 목록" 버튼으로 확인. Gemini 카드를 비우면 Lyria 키 공유

### Google Lyria (연주곡 전용 소스)

연주곡 프리셋(로파이 등)이나 보컬 옵션을 "연주곡"으로 둔 경우에만 쓸 수 있는 두 번째 생성 소스. Gemini API의 `lyria-3.5`(또는 `lyria-3-pro-preview`)를 Interactions API(background 실행 → 폴링)로 호출한다.

- 키: [Google AI Studio](https://aistudio.google.com/apikey)에서 발급. 무료 티어가 없어 결제가 연결된 Google Cloud 프로젝트가 필요하다. 상단 [설정] 모달의 Lyria 카드에 입력하거나 환경변수 `GEMINI_API_KEY`로 전달.
- 비용: 곡당 $0.08 (2026-10 기준, 프리뷰라 변동 가능). 앱은 시작 전 예상 금액을 확인창으로 보여 준다.
- 왜 연주곡만: Lyria는 가사 텍스트는 주지만 **단어별 타이밍을 주지 않아** 박자에 맞는 가사 자막을 만들 수 없다. 보컬곡은 Treblo 소스를 쓴다. 서버가 보컬 요청을 거부한다.
- 프리셋 변환: Treblo용 `length_range`는 "Target length about N–M minutes", `negative_tags`는 "Avoid: …" 문장으로 프롬프트에 녹인다. `tags`·`style_scale`은 무시한다.
- 모든 출력에 SynthID 워터마크(비가청)가 들어간다. Gemini API 약관은 생성물 소유권을 주장하지 않지만 유튜브 수익화·Content ID 안전성을 보장하지는 않으므로 업로드 전 약관을 확인한다. 유튜브 설명 푸터는 자동으로 "Music generated with Google Lyria"로 바뀐다.

### Mureka API (보컬·연주곡 소스)

[Mureka 공식 API](https://platform.mureka.ai/docs)를 쓰는 세 번째 생성 소스. 보컬곡·연주곡 모두 되고 줄·단어별 가사 타임스탬프를 주므로 Treblo처럼 박자에 맞는 자막이 나온다.

- 키: [platform.mureka.ai/apiKeys](https://platform.mureka.ai/apiKeys)에서 발급(잔액 선결제). 상단 [설정] 모달의 Mureka 카드에 입력하거나 환경변수 `MUREKA_API_KEY`로 전달. [잔액 확인]은 `GET /v1/account/billing`(과금 없음).
- 비용: 모델별 곡당 요금([요금표](https://platform.mureka.ai/pricing)). 요청마다 `n: 1`로 보내 곡 하나만 청구되게 한다(기본값 2). 기본 티어는 동시 요청 1개이며, 설정의 동시 생성 수가 계정 한도(`concurrent_request_limit`)를 넘으면 작업 시작 시 자동으로 낮춘다.
- 흐름: 보컬곡은 `POST /v1/lyrics/generate`(프롬프트에 언어·주제 포함) → `POST /v1/song/generate {lyrics, model, prompt, n:1, gender}`, 연주곡은 `POST /v1/instrumental/generate`(o2 미지원 → auto). `/v1/{song|instrumental}/query/{id}`를 폴링해 `succeeded`가 되면 `choices[0].url`(mp3)을 내려받고 `lyrics_sections`의 줄·단어 타이밍(ms → 초)을 자막에 쓴다. 줄 타이밍이 있으면 단어 정렬보다 우선한다.
- 프리셋 변환: `tags`는 "jazz, slow, female vocal" 식 스타일 프롬프트 앞부분, `negative_tags`는 "Avoid: …", `length_range`·`style_scale`은 무시(길이 제어 없음). 프롬프트 상한 1024자.
- `tracks/NN_generation.json`에 `word_aligned_lyrics`(Treblo와 같은 필드명, 초)와 `timed_lines`를 저장해 조합(compile) 소스가 그대로 다시 쓴다. 유튜브 설명 푸터는 "Music generated with Mureka".

## 구조

```
server/            Express 서버 (API, SSE 진행 상황, 종료·업데이트)
  pipeline.js      9단계 파이프라인
  providers/       treblo.js (Treblo API), lyria.js (Google Lyria, 연주곡 전용), mureka.js (Mureka API, 보컬·연주곡), local.js (input 폴더)
  media/           ffmpeg.js (정규화·결합·렌더링), subtitles.js (ASS)
  youtube.js       제목·설명·챕터
mcp/server.js      MCP 서버 (Claude 연동)
presets/*.json     장르 프리셋
scripts/thumbnail.py  배경·썸네일 (Pillow)
public/            UI (8pt, 1920×1080 기준)
```

## 주의: 배치 파일 인코딩

`START.bat`, `install.bat`, `STOP.bat`은 한국어 Windows 기본 인코딩(CP949, ANSI)으로 저장되어 있다. UTF-8로 다시 저장하면 cmd가 한글 줄 뒤의 명령을 잘라먹는 버그가 생기므로, 편집 후에는 반드시 ANSI(CP949)로 저장한다.

## 테스트

```
npm run test:mock            # 합성음 3곡으로 전체 파이프라인 검증 (API 호출 없음)
node scripts/test-mock.js lofi-study 2 10
```
