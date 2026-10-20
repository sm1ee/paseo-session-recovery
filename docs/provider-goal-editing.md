# 제공자별 Goal 편집 조사

확인 날짜: 2026-10-20. v0.5.0은 기존 Codex 편집기에 OpenCode와 Claude Code를 연결한다.

| 제공자 | 본문 조회 | 현재 목표 본문 수정 | 이번 처리 |
| --- | --- | --- | --- |
| Codex | `thread/goal/get` | Paseo의 대화 소유 연결이 `/goal <objective>`를 처리하며 `thread/goal/set` 호출 | 조회·편집 UI와 검증을 추가 |
| OpenCode Goal plugin | 기존 플러그인이 읽는 세션별 snapshot | 네이티브 `/goal edit <objective>`와 `update_goal` 도구가 존재 | slash 명령으로 편집하고 ID·예산·사용량 보존을 확인 |
| Claude Code | 현재 대화 가지의 네이티브 `goal_status` 기록 | `/goal <condition>`이 조건을 교체하고 즉시 턴을 시작 | 교체와 카운터 초기화를 명시한 편집기를 추가 |
| OMP 18.11.3 | RPC Goal `get`과 구조화된 Goal 기록 | 확인한 RPC와 Goal 도구에는 본문 수정 연산이 없음 | 기존 목표를 삭제·재생성하는 방식으로 대체하지 않음 |

## Codex

Paseo v0.12.0의 Codex 제공자는 목표 설정 시 `objective`와 `status: "active"`를 전달한다. 편집기의 버튼은 **Save**로 표시하며, 실제 활성화 여부는 Codex가 반환하는 상태를 따른다. 편집기는 예산을 변경하지 않고 결과를 다시 읽어 확인한다. 새 목표에 대한 Paseo 자동 진행 선택은 별도로 필요하다.

읽기 전용 보조 app-server는 기존처럼 `initialize`와 `thread/goal/get`만 사용한다. 목표 변경은 대화를 소유한 Paseo 연결로 보낸다. 저장 전 목표의 본문·상태·식별자·예산과 대화 상태를 재확인하고, 불확실한 편집은 자동 재전송하지 않는다. 조건부 원자적 갱신 API는 없어 재확인과 제출 사이의 경합을 완전히 제거하지는 못한다.

출처: [Paseo Codex 제공자](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/server/src/server/agent/providers/codex-app-server-agent.ts#L5188).

## OpenCode

확인한 upstream pin은 `2ef30137d666d50b252b8f4af144a1997fa53dcf`다. `/goal edit <objective>`는 목표 식별자, 토큰·턴·시간 예산과 이력을 유지하면서 본문을 수정한다. 새 `runId`를 발급해 진행 중인 작업·검토 결과를 무효화하고, 멈춤 상태를 해제해 목표를 활성화한다. 한도에 도달한 목표는 다음 idle 검사에서 다시 멈추며 `/goal resume`는 별도로 예산 창을 초기화한다.

`update_goal` 도구의 본문 수정은 정지 상태를 유지한다. slash 명령과 도구의 상태 전이가 다르므로 편집기는 네이티브 slash 명령을 쓴다. 수동 편집·일시정지·재개는 토큰·시간 사용량 계산으로 막지 않고, 실제 실행 가능 여부는 OpenCode에 맡긴다. OpenCode의 편집 명령은 작업을 시작하므로 대화가 idle인 동안만 저장할 수 있다.

실제 로컬 OpenCode 2.0.32와 opencode-goal-plugin 0.8.2의 새 시험 대화에서 본문 편집 후 같은 Goal ID·예산 창·턴/토큰/시간 한도·사용량·이력 보존을 확인했다. 따옴표와 줄바꿈도 보존한다. 이 설치본과 위 upstream pin의 세부 구현은 구분한다. 처음 시험에서는 오래된 기본 모델 참조로 네이티브 명령 자체가 실패했다. 시험 작업공간에만 유효한 모델과 Goal 모드 등록 정보를 지정했고 사용자 전역 설정은 변경하지 않았다.

출처: [본문 수정 도구](https://github.com/william-ricchiuti/OpenCode-goal-plugin/blob/2ef30137d666d50b252b8f4af144a1997fa53dcf/src/goal-plugin.js#L3396), [네이티브 edit 명령](https://github.com/william-ricchiuti/OpenCode-goal-plugin/blob/2ef30137d666d50b252b8f4af144a1997fa53dcf/src/goal-plugin.js#L5404).

## Claude Code

공식 `/goal`은 현재 조건 조회와 교체·해제를 제공한다. 조건 변경은 별도 편집 RPC가 아니라 `/goal <condition>`으로 처리하며 즉시 새 턴을 시작한다. 기존 조건을 대체하고 Goal의 시간·평가 턴 수·토큰 사용 기준점을 초기화하므로 **Replace goal and start** 버튼과 설명을 사용한다. Codex/OpenCode처럼 Goal 예산을 보존하는 편집으로 표시하지 않는다. 별도의 Goal 토큰 예산은 공개되지 않는다.

로컬 Claude Code 2.1.302와 Paseo에 포함된 Claude Agent SDK 0.3.246을 확인했다. SDK는 `active_goal` 이벤트를 공개하지만 현재 Paseo 플러그인 API는 이를 직접 조회하는 경로가 없다. 편집기는 Claude가 복원에 쓰는 `goal_status` attachment를 네이티브 세션 JSONL에서 읽고 `parentUuid`를 따라 현재 가지의 상태만 채택한다. 완료·해제·실패 기록, 불완전한 행, 알 수 없는 연결은 편집 가능한 활성 상태로 추정하지 않는다. 최대 8 MiB만 읽고 목표를 찾거나 현재 가지를 확인할 수 없으면 읽기 전용으로 둔다. 저장 파일은 수정하지 않는다.

상속된 제공자 환경의 `CLAUDE_CONFIG_DIR`를 따른다. 별도 launch wrapper나 hook이 비공개로 디렉터리를 바꾸는 경우에는 같은 경로를 제공자 환경에 명시해야 한다. 백그라운드 발견 조회에는 Claude transcript 읽기를 추가하지 않았다. 선택한 Claude 목표도 네이티브 루프가 진행하므로 Paseo가 추가 자동 진행 메시지를 보내지 않는다.

새 시험 대화에서 실제 RPC 조회→교체→다시 읽기, 일회용 티켓 재전송 거부와 외부에서 교체된 목표 보존을 확인했다. 네이티브 조회·편집과 모바일/데스크톱 화면 직접 확인은 별도 검증이다.

출처: [공식 Claude Goal 설명](https://code.claude.com/docs/en/goal), [Claude Agent SDK 0.3.246 타입](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.246/sdk.d.ts), [Paseo Claude 명령 전달](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/server/src/server/agent/providers/claude/agent.ts#L2954), [Paseo의 Claude transcript 경로](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/server/src/server/agent/providers/claude/project-dir.ts).

## OMP

로컬 설치 버전은 18.11.3이고 배포 build pin은 `96894a6`이다. 같은 태그의 source commit `96894a6147d8cc64b7e00ad3a7d7178fd93b9531`을 확인했다. RPC의 연산은 `get`, `create`, `resume`, `pause`, `drop`이며 본문 `edit`나 `update`는 없다. Goal 도구 역시 `create`, `get`, `complete`, `resume`, `drop`만 제공한다. 활성·일시정지 목표가 있으면 `create`도 거부한다.

기존 목표를 유지하면서 수정하는 UI를 제공하려면 OMP의 목표 변경 연산과 Paseo를 통한 호출 경로가 추가되어야 한다. 목표를 지운 뒤 새로 만드는 작업은 예산과 이력이 달라질 수 있어 이번 편집 기능에 포함하지 않았다. 실제 사용자 Goal을 변경하거나 목표 저장 파일을 직접 수정하지 않았다.

출처: [OMP RPC 연산과 생성 제한](https://github.com/can1357/oh-my-pi/blob/96894a6147d8cc64b7e00ad3a7d7178fd93b9531/packages/coding-agent/src/modes/rpc/rpc-goal.ts#L21), [Goal 도구 계약](https://github.com/can1357/oh-my-pi/blob/96894a6147d8cc64b7e00ad3a7d7178fd93b9531/packages/coding-agent/src/goals/tools/goal-tool.ts#L21).


## v0.5.1 버튼 표시 수정 (2026-10-21)

Goal 조회 진입과 자동 이어가기 검증을 분리했다. Codex·OMP·Pi·Claude·OpenCode에서는 대화 메타데이터만으로 Goal 진입을 먼저 등록한다. iPhone을 포함해 실제 composer의 아이콘이 마운트된 대화만 주기적으로 점검하고, 전체 저장 대화에 대한 제공자 조회를 반복하지 않는다. 검증된 Goal은 기존 On/Off 토글을 유지하고, 검증 전·완료 후·조회 실패 때에는 Goal 화면으로 들어가는 버튼을 유지한다.

Goal 화면을 열면 현재 대화 한 개를 명시적으로 검사한다. OMP/Pi는 기존 구조화된 타임라인 판독으로 이어가기를 선택할 수 있고 본문 편집은 계속 제공하지 않는다. Claude는 네이티브 상태를 읽어 이어가기 선택과 편집 가능 여부를 각각 표시한다. 조회만으로 목표를 선택하거나 실행하지 않는다.

## v0.6.0 목표 미리보기와 재생 제어 (2026-10-21)

입력창 위에 네이티브 목표의 상태와 축약 본문을 표시한다. 문구를 누르면 데스크톱에서는 popover, 모바일에서는 bottom sheet로 본문 편집기를 연다. Codex와 OpenCode의 네이티브 일시정지·재개는 별도 버튼이다. 기존 Paseo 추가 이어가기 선택은 편집기의 Details로 이동했고 네이티브 제어와 구분한다.

Codex 명령은 기존 대화 소유 연결에서 `/goal pause`와 `/goal resume`을 한 번 전송하고, 같은 목표 신원·본문·예산·누적 사용량 및 결과 상태를 확인한다. 별도 조회 app-server는 읽기만 한다. OpenCode는 현재 턴이 끝난 대화에서만 제어한다. 재개 시 네이티브 예산 창이 초기화되므로 편집 시트에서 예산 초기화를 한 줄로 안내하고 Resume을 명시적으로 누르게 한다. 수동 제어는 네이티브 상태를 따르고, 자동 이어가기의 한도 검사는 별도로 유지한다.

Claude 공식 명령에는 명시적인 pause/resume이 없으므로 해당 버튼을 제공하지 않는다. `/goal pause`를 목표 본문으로 전송하지 않는다. OMP 네이티브 RPC에는 pause/resume이 있지만 Paseo 0.12.0 제공자 연결의 공개 SDK에는 이를 기존 소유 프로세스로 전달하는 경로가 확인되지 않았다. 별도 OMP 프로세스를 띄워 사용자 대화를 중복 복원하지 않으며, OMP/Pi의 본문은 명시적 타임라인 조회에서 읽기 전용으로 표시한다.

네이티브 제어는 5분 기한의 일회용 티켓으로 목표와 대화 변경을 검증하고 전송 의도를 먼저 저장한다. 응답이 불확실하면 재전송하지 않고 검토 상태로 남긴다. 본문과 티켓은 journal에 저장하지 않는다. 현재 보이는 composer만 목표 미리보기를 읽고 OMP/Pi 타임라인은 자동 복원하지 않는다. Claude 미리보기는 선택된 대화의 제한된 transcript를 읽는다.

OpenCode의 휴면 대화는 Paseo 저장 payload에 availableModes가 비어 있다. 이 경우 기록된 현재 모드가 정규 goal ID이고 버전·세션·목표가 검증되는 네이티브 스냅샷이 있을 때 상태를 읽는다. 현재 모드가 바뀌었거나 실제 모드 등록 설명이 충돌하면 계속 거부한다. 이름만 goal인 모드는 목표 존재의 근거가 아니며, 본문 저장 전에는 네이티브 명령 등록과 현재 상태를 다시 검증한다.

사용자 요청에 맞춰 기본 화면은 목표 본문과 Pause/Resume, 수정 중 Save/Discard만 표시하도록 줄였다. 제공자·사용량·긴 설명·추가 이어가기 설정은 Details 안에 접었다. OpenCode 재개의 예산 초기화와 Claude 편집의 타이머 초기화처럼 결정에 필요한 안내만 한 줄로 남긴다.

## v0.6.1 수동 제어

OpenCode의 누적 컨텍스트 토큰과 시작 시각을 재계산해 수동 UI까지 limited로 잠그던 경로를 제거했다. Codex도 수동 편집·재개를 사용량만으로 거부하지 않는다. 자동 이어가기용 보수적 상태 조회와 수동 네이티브 상태 조회를 분리한다. 네이티브가 이미 제한 상태여도 명시적인 편집·재개 요청을 제공자에게 전달하며, 사용량이나 설정을 플러그인이 직접 초기화하지 않는다. OpenCode resume은 기존 안내와 명시적 클릭에서만 새 예산 창을 시작한다. 실행 중인 OpenCode/Claude는 기존 명령 전송 경로의 idle 검사와 현재 세션 신원 검사를 유지한다. 잠긴 제어는 사라지지 않고 비활성화되며, 편집기에는 사유와 Reload가 바로 표시된다.
