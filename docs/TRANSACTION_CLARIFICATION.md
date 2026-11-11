# Shared transaction clarification

This document records the builder's bounded presentation slice and the integration
contract to be reviewed before implementing saved answers. It grants no schema,
storage, provider write, credential, hosting change or financial activation.

## Presentation slice

The parent supplied a textual layout specification after the supported Library
materializer failed on Windows at os.setxattr. The builder did not view the
reference pixels. Illustration dimensions are not literal CSS dimensions.
Existing Atlas theme tokens and Geist remain the presentation source.

The three toolbar controls are the existing theme control, the same Manual
Refresh button/handler, and a review opener. The existing Today control moves
beside the period navigator. The same native Budget detail controller owns
the review sheet, focus, Escape and dismissal.

Responsive and OS-theme rerenders restore this header-owned source/opener through
two fixed native-controller presentation identities. Unchanged projected markup
retains its existing read-only row nodes and transient navigation; changed facts
or periods rebuild them. The native controller restores a still-enabled review
control's focus, with its close control as the fallback, and dismissal returns
to the toolbar opener. This is not transaction identity or decision persistence.

The review displays only Forecast.currentPeriodAction.outgoingETransfers facts.
Date, amount, account and posting state are explicitly projected. No descriptor,
payee, note, provider ID or coverage reference is placed in the DOM. Current
transfers are not displayed under a selected past/future period or month.
Stale/unavailable evidence publishes no resurrected rows. The total of genuine
owner questions across purchases, transfers and payment matches is unavailable:
the badge displays ?, never zero, a made-up total or the observed-transfer count.
Positions describe transient navigation through observed rows and are never saved
identity. The existing source-check node remains reachable in the sheet. Existing
refresh loading/failure/retry behavior remains visible and unchanged.

No Save, answer choices or history claims are offered until the following real
contract is connected. The existing inline #604 transfer disclosure is retained.

## One shared review contract

There is one review shell and one server-owned collection of answerable questions.
The browser must receive a tagged publication; it must not classify transactions,
choose payment matches, infer from notes, synthesize questions from missing
coverage or convert observed rows into saved identity.

| Type | One answerable question | Separate evidence needed |
| --- | --- | --- |
| purchase-classification | Which existing category describes this exact purchase? | Posting identity, pending/posted lifecycle, admissible category and retained correction qualification. |
| transfer-purpose | What was this exact transfer for? | Bill settlement, any card allocation, matched legs and completeness. Purpose alone proves none of these. |
| payment-allocation | Which purchases or explicit nonpurchase remainder does this matched payment cover? | Exact debit/credit match, amounts, aggregate retained claims and separate issuer minimum settlement. |

Each published question has an opaque server-resolved stable question/transaction
reference, tagged type, exact evidence revision, verified display facts, unknown
facts, one question and an explicit supported answer domain. Financial consequences
come from Forecast. Duplicate rows or multiple uncertainty reasons are not multiple
owner questions. Missing coverage is a separate notice with no owner-question
count. A zero badge is allowed only when the complete typed publication attests
zero currently answerable questions.

The server resolves the selected reference back to private provider/account identity.
The current observer's tx-N alias is not saved identity. Its existing pc- coverage
reference provides one incumbent bounded identity mechanism, but its pending/posted
qualification and purpose beyond card coverage must be proved before reuse.
Do not widen it by naming it stable or expose raw identity to the browser.

The operation sequence is prepare, explicit exact-preview confirmation, confirm,
and operation-specific outcome lookup. Preview binds actor, type, exact identity,
evidence digest, current saved revision, intended answer and Forecast consequence.
Changed evidence or revision rejects; it does not silently rebase. One operation
ID admits one payload, with atomic idempotent receipts and concurrency conflict
handling. Failed and uncertain saves are distinct. An uncertain operation is
verify-first; matching displayed values is not proof, and no automatic retry is
allowed. Closing/reopening or a second device must preserve the unresolved
operation's actual server outcome.

Resolved history is distinct from the manageable active queue. Change and undo
name the current saved head and exact preview revision. Undo withdraws
interpretation; it never reverses money. Immutable predecessors and receipts
remain auditable. Evidence loss withholds qualification and never silently erases
retained payment/purchase-cent claims. Requalification and Forecast input composition
must use the complete retained cohort once, avoiding duplicate claims/deductions.

## Reuse boundary and engineering qualification

Browser authentication already uses signed expiring HttpOnly hfd_session cookies;
sessions need no new account platform. The decision controller requires an
authenticated actor adapter; the existing ephemeral Talk session buffer is not
decision storage.

scripts/card-payment-decision-store.js and scripts/card-payment-decisions.js
already supply a payment-specific revisioned intent/receipt foundation, exact
preview qualification, outcome lookup, replace/retract and retained-cohort
validation through Forecast. They have no live session routes or environment
activation on the inspected main. Reuse payment semantics there instead of
pretending transfer purpose is an allocation or creating a second allocator.

The isolated form public/transaction-edit.js (removed 2026-11-11 by owner decision,
#821 comment 6786692208) provided useful prepare/apply/outcome and verify-first
interaction semantics; its history is in git. Its in-memory mock is not durability. Interactive provider
edits and signed routine cleanup have different provider-write/access semantics
and do not authorize this provider-free purpose store.

The checked render.yaml specifies plan: free and has no disk mount. The existing
private-period history documentation likewise records an ephemeral free Render
filesystem. server-observation-memory.js is deliberately process-local evidence,
not retained intent. The POSIX decision adapter requires an owner-private directory
outside repository/static paths, no symlinks, exclusive writer lock, atomic
same-directory replacement, file sync and directory sync. Windows ACL/directory
durability and actual deployed Render persistence are unqualified.

This is an engineering investigation. Qualification needs the actual supported
private runtime destination and filesystem, persistence across sleep/restart and
redeploy, one-writer/concurrency behavior, backup/restore and locked/corrupt/missing
state recovery. Synthetic process restart is not deployed durability proof.
Construction and synthetic tests can continue while those are investigated.
No new paid resource, credential, consent, hosting change, migration or activation
is authorized by this document. If existing deployment lacks the capability,
present the specific approved-resource options and verified prices separately.

Muse owns the source-check receipt changes in server.js, scripts/assistant-packet.js,
test-assistant-interface.js and test-server-observation-memory.js. This slice
does not edit them. Session wiring and shared input-revision composition wait
for parent sequencing after that work.

## Completion criteria

The presentation Draft PR needs unchanged base/head Forecast and real-rendered
figures, an independently failing-before/passing-after toolbar regression, native
dismissal/reopen/repeated taps/navigation, truthful unknown badge/status and no
overflow at 320/390/1440 in both themes. Browser emulation is separate from
physical Safari/home-screen acceptance.

Saved-decision integration additionally needs stable identity including posting
replacement/collisions, exact evidence/revision and stale preview proof, concurrency
and idempotence, failed/uncertain outcomes, history change/undo, restart and
second-device proof, no double-counting, and the qualified production destination.
Parent owns Systems Review and release. Builders do not merge or deploy.
