# 제공자별 Goal 편집 조사

확인 날짜: 2026-10-20. 이번 릴리스에는 Codex 편집기만 추가했다.

| 제공자 | 본문 조회 | 현재 목표 본문 수정 | 이번 처리 |
| --- | --- | --- | --- |
| Codex | `thread/goal/get` | Paseo의 대화 소유 연결이 `/goal <objective>`를 처리하며 `thread/goal/set` 호출 | 조회·편집 UI와 검증을 추가 |
| OpenCode Goal plugin | 기존 플러그인이 읽는 세션별 snapshot | 네이티브 `/goal edit <objective>`와 `update_goal` 도구가 존재 | 동작 조사 완료, 편집기 연결은 미포함 |
| OMP 18.11.3 | RPC Goal `get`과 구조화된 Goal 기록 | 확인한 RPC와 Goal 도구에는 본문 수정 연산이 없음 | 기존 목표를 삭제·재생성하는 방식으로 대체하지 않음 |

## Codex

Paseo v0.12.0의 Codex 제공자는 목표 설정 시 `objective`와 `status: "active"`를 전달한다. 따라서 멈춘 목표에는 편집기의 버튼을 **Save and activate**로 표시한다. 편집기는 예산을 변경하지 않고 결과를 다시 읽어 확인한다. 새 목표에 대한 Paseo 자동 진행 선택은 별도로 필요하다.

읽기 전용 보조 app-server는 기존처럼 `initialize`와 `thread/goal/get`만 사용한다. 목표 변경은 대화를 소유한 Paseo 연결로 보낸다. 저장 전 목표의 본문·상태·식별자·예산과 대화 상태를 재확인하고, 불확실한 편집은 자동 재전송하지 않는다. 조건부 원자적 갱신 API는 없어 재확인과 제출 사이의 경합을 완전히 제거하지는 못한다.

출처: [Paseo Codex 제공자](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/server/src/server/agent/providers/codex-app-server-agent.ts#L5188).

## OpenCode

확인한 upstream pin은 `2ef30137d666d50b252b8f4af144a1997fa53dcf`다. `/goal edit <objective>`는 목표 식별자, 토큰·턴·시간 예산과 이력을 유지하면서 본문을 수정한다. 새 `runId`를 발급해 진행 중인 작업·검토 결과를 무효화하고, 멈춤 상태를 해제해 목표를 활성화한다. 한도에 도달한 목표는 다음 idle 검사에서 다시 멈추며 `/goal resume`는 별도로 예산 창을 초기화한다.

`update_goal` 도구의 본문 수정은 정지 상태를 유지한다. 즉 slash 명령과 도구의 상태 전이가 다르다. Paseo 편집기로 연결할 때는 사용자가 요청한 활성화 여부와 실제 네이티브 결과를 구분해야 한다. 로컬 OpenCode 설정에 Goal plugin 선언은 확인했으나, 이 조사는 해당 설치본의 편집 동작을 실제로 실행한 검증은 아니다.

출처: [본문 수정 도구](https://github.com/william-ricchiuti/OpenCode-goal-plugin/blob/2ef30137d666d50b252b8f4af144a1997fa53dcf/src/goal-plugin.js#L3396), [네이티브 edit 명령](https://github.com/william-ricchiuti/OpenCode-goal-plugin/blob/2ef30137d666d50b252b8f4af144a1997fa53dcf/src/goal-plugin.js#L5404).

## OMP

로컬 설치 버전은 18.11.3이고 배포 build pin은 `96894a6`이다. 같은 태그의 source commit `96894a6147d8cc64b7e00ad3a7d7178fd93b9531`을 확인했다. RPC의 연산은 `get`, `create`, `resume`, `pause`, `drop`이며 본문 `edit`나 `update`는 없다. Goal 도구 역시 `create`, `get`, `complete`, `resume`, `drop`만 제공한다. 활성·일시정지 목표가 있으면 `create`도 거부한다.

기존 목표를 유지하면서 수정하는 UI를 제공하려면 OMP의 목표 변경 연산과 Paseo를 통한 호출 경로가 추가되어야 한다. 목표를 지운 뒤 새로 만드는 작업은 예산과 이력이 달라질 수 있어 이번 편집 기능에 포함하지 않았다. 실제 사용자 Goal을 변경하거나 목표 저장 파일을 직접 수정하지 않았다.

출처: [OMP RPC 연산과 생성 제한](https://github.com/can1357/oh-my-pi/blob/96894a6147d8cc64b7e00ad3a7d7178fd93b9531/packages/coding-agent/src/modes/rpc/rpc-goal.ts#L21), [Goal 도구 계약](https://github.com/can1357/oh-my-pi/blob/96894a6147d8cc64b7e00ad3a7d7178fd93b9531/packages/coding-agent/src/goals/tools/goal-tool.ts#L21).
