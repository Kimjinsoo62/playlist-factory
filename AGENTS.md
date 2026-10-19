# AGENTS.md

이 저장소에서 작업하는 AI 코딩 에이전트(Codex 등)를 위한 안내.

프로젝트 구조·명령·주의 사항은 모두 [`CLAUDE.md`](CLAUDE.md)에 있다. 작업 전에 그 파일을 읽고 그대로 따른다. 내용이 어긋나지 않도록 이 파일에는 따로 적지 않는다.

특히 지킬 것 (자세한 내용은 CLAUDE.md):

- treblo·lyria 소스로 작업을 시작하면 실제 과금된다. 검증은 `npm run test:mock` 또는 mock(`dryRun`)으로만 한다.
- 배치 파일은 CP949 + CRLF다. UTF-8로 저장하지 않는다.
- `config.json`에는 실제 API 키가 있다. 내용을 출력하지 않는다.
- 코드 주석·로그·UI·커밋 메시지는 한국어로 쓴다.
