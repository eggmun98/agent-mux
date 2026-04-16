# agent-mux

`agent-mux`는 AI 에이전트 CLI를 프로필 단위로 분리해 쓰기 위한 비공식 확장형 래퍼 CLI입니다.

커맨드: `amux`.

현재 내장 provider:
- Codex CLI (`codex`)
- Claude Code CLI (`claude`)
- Gemini CLI (`gemini`)

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
  - Gemini CLI: `gemini`

## 설치 및 업데이트

전역 설치:

```bash
npm install -g @eggmun/agent-mux@latest
```

특정 버전 설치:

```bash
npm install -g @eggmun/agent-mux@0.1.2
```

업데이트:

```bash
npm install -g @eggmun/agent-mux@latest
```

확인:

```bash
amux --version
amux --help
```

`npx`로 바로 실행할 수도 있습니다.

```bash
npx @eggmun/agent-mux@latest --version
```

## 개발용 로컬 설치

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
- `amux use [profile]`
- `amux current`
- `amux list`
- `amux providers`

Provider 명령:
- `amux codex login|logout|status|run [args...]`
- `amux claude login|logout|status|run [args...]`
- `amux gemini login|logout|status|run [args...]`

Codex 원격 로그인 보조 명령:
- `amux codex login-device` -> `codex login --device-auth`
- `amux codex callback` -> 브라우저의 `http://localhost:<port>/...` redirect URL을 현재 머신의 Codex 로그인 서버로 전달

선택형 별칭:
- `amux use` -> 등록된 프로필 목록에서 선택
- `amux login` -> provider 목록에서 선택 후 login
- `amux login <provider>` -> 선택 프롬프트 없이 해당 provider login

기존 호환 별칭:
- `amux logout` -> `amux codex logout`
- `amux run` -> `amux codex run`
- `amux run <profile>` -> `amux use` 없이 해당 프로필로 Codex 실행

Provider 단축 실행:
- `amux codex run <profile>`
- `amux claude run <profile>`
- `amux gemini run <profile>`

## Quick Start

Terminal 1 (계정 A):

```bash
amux use a
amux login
amux codex run
amux run a
```

Terminal 2 (계정 B):

```bash
amux use b
amux login claude
amux claude run
```

프로필 이름을 기억하지 않아도 됩니다.

```bash
amux use
```

provider 이름을 기억하지 않아도 됩니다.

```bash
amux login
```

provider를 바로 지정하면 선택 목록 없이 실행됩니다.

```bash
amux login codex
amux login claude
amux login gemini
```

상태 확인:

```bash
amux current
amux list
amux list --json
amux codex status
amux claude status
amux gemini status
```

## 로그인 처리 원칙

amux는 OAuth/브라우저 인증 과정을 자동화하지 않습니다.

`amux login`, `amux codex login`, `amux claude login`, `amux gemini login` 실행 시 브라우저 인증과 터미널 확인은 사용자가 직접 수행하고, amux는 프로필별 저장 경로 분리만 담당합니다.

Gemini CLI는 별도 `login` CLI subcommand가 아니라 `gemini` 실행 후 auth 화면에서 로그인하는 방식입니다. `amux gemini login`과 `amux login gemini`는 선택한 프로필의 `GEMINI_CLI_HOME`을 주입한 상태로 Gemini CLI를 실행합니다.

## SSH/원격 Codex 로그인

원격 서버, VM, EC2처럼 브라우저가 없는 환경에서는 우선 device-code 로그인을 사용합니다.

```bash
amux use a
amux codex login-device
```

같은 동작을 직접 전달해도 됩니다.

```bash
amux codex login --device-auth
```

브라우저 로그인 URL을 반드시 써야 하는 경우에는 Codex 로그인 프로세스를 원격 터미널에 켜 둔 상태에서, 로컬 브라우저 주소창에 뜬 `http://localhost:<port>/...` redirect URL을 원격 터미널의 `amux codex callback`에 붙여넣을 수 있습니다.

```bash
# 원격 터미널 A
amux codex login

# 로컬 브라우저에서 인증 후 localhost redirect URL을 복사

# 원격 터미널 B
amux codex callback
```

redirect URL에는 일회성 인증 코드나 토큰이 들어갈 수 있습니다. 채팅, 이슈, 쉘 히스토리에 남기지 말고 가능하면 `amux codex callback` 프롬프트에 직접 붙여넣으세요.

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
