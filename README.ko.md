# agent-mux

`agent-mux`는 AI 에이전트 CLI를 프로필 단위로 분리해 쓰기 위한 비공식 확장형 래퍼 CLI입니다.

커맨드: `amux`.

현재 내장 provider:
- Codex CLI (`codex`)
- Claude Code CLI (`claude`)

터미널 A는 계정 A, 터미널 B는 계정 B처럼 동시 사용하면서 provider별 저장 경로를 프로필로 격리할 수 있습니다.

## agent-mux를 쓰는 이유

- 매번 로그아웃/로그인 반복 감소
- 인증/로컬 상태를 프로필별로 분리
- 모든 provider를 같은 명령 구조로 사용 (`amux <provider> ...`)
- Gemini 등 새 provider 추가 시 코어 로직 재작성 최소화

## Important Notice (Unofficial)

- 이 프로젝트는 OpenAI, Anthropic, Google의 공식 제품이 아닙니다.
- 서비스/제품 이름은 각 권리자에게 있습니다.
- amux는 설치된 CLI를 호출하고 환경변수 경로를 분리하는 래퍼입니다.

## Prerequisites

- Node.js + npm
- provider CLI가 PATH에 설치되어 있어야 함
  - Codex CLI: `codex`
  - Claude Code CLI: `claude`

## 설치 (로컬)

```bash
npm install
npm run build
npm link
```

확인:

```bash
amux --help
```

## 명령 구조

공통 프로필 명령:
- `amux use <profile>`
- `amux current`
- `amux list`
- `amux providers`

Provider 명령:
- `amux codex login|logout|status|run [args...]`
- `amux claude login|logout|status|run [args...]`

기존 호환 별칭:
- `amux login` -> `amux codex login`
- `amux logout` -> `amux codex logout`
- `amux run` -> `amux codex run`
- `amux run <profile>` -> `amux use` 없이 해당 프로필로 Codex 실행

Provider 단축 실행:
- `amux codex run <profile>`
- `amux claude run <profile>`

## Quick Start

Terminal 1 (계정 A):

```bash
amux use a
amux codex login
amux claude login
amux codex run
amux run a
```

Terminal 2 (계정 B):

```bash
amux use b
amux codex login
amux claude login
amux claude run
```

상태 확인:

```bash
amux current
amux list
amux list --json
amux codex status
amux claude status
```

## 로그인 처리 원칙

amux는 OAuth/브라우저 인증 과정을 자동화하지 않습니다.

`amux codex login`, `amux claude login` 실행 시 브라우저 인증과 터미널 확인은 사용자가 직접 수행하고, amux는 프로필별 저장 경로 분리만 담당합니다.

## 저장 경로와 업데이트 안전성

기본 홈 디렉터리 결정 순서:
1. `AMUX_HOME`
2. 기본값 `~/.amux`

상태 파일:
- `state.json`
- `state.backup.json` (덮어쓰기 전 자동 백업)

amux는 아래를 통해 업그레이드 시 데이터 손실을 줄입니다:
- 상태 스키마 버전 관리 (`v3`)
- 구버전 자동 마이그레이션 (`codex-mux v1`, unified v2)
- 원자적 저장 (`temp file + rename`)

amux는 기존 `mux` 경로와 의도적으로 분리되어 프로젝트 간 프로필 충돌을 방지합니다.

## Provider 확장 (Gemini 등)

이 CLI는 provider 레지스트리 기반입니다. 새 provider를 추가할 때 `src/index.ts`에서 아래만 정의하면 됩니다:
- provider id/label
- binary 이름
- env var 키
- 기본 홈 디렉터리명
- login/logout args
- status 판별 함수

provider 정의 1개를 추가하면 `amux <provider> login/logout/run/status` 명령이 자동 생성됩니다.
