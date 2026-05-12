# nueip-mcp

An MCP (Model Context Protocol) server that exposes nueip.com's HR / attendance APIs as tools, so an LLM client can clock in/out, look at attendance, query leave balances with expiry, file leave, approve subordinates' 補卡 — without leaving the chat.

## Code layout

```
src/
├── index.ts     # MCP server entry; registers tools, handles NueipError → tool error response
├── config.ts    # loads NUEIP_* env vars + optional location presets JSON
├── client.ts    # NueipClient: login, identity, cookie jar, every endpoint method, 401 auto-retry
├── format.ts    # turns nueip's HTML-laden raw responses into compact JSON for list_attendance / list_leaves / leave_balance / list_pending_approvals
└── tools.ts     # zod schemas + MCP tool defs that wrap client methods
tests/
├── fixtures/    # captured raw responses (sanitised)
└── format.test.ts  # snapshot-style tests over the formatters
```

Per-file conventions:
- **client.ts is the only file that talks HTTP.** Everything else operates on the JSON.
- **format.ts is read-side only** — it never mutates state. Mutations go through client → tools handler directly.
- **tools.ts handlers should be one-liners** that map zod-validated input to a client method. If a handler has logic, that logic belongs in client.ts.

## How nueip's API works (the parts that bite)

Auth: `cloud.nueip.com/login/index/param` (POST form) → cookies, then `oauth2/token/api` (GET) → Bearer JWT. Session cookies + bearer needed together. Idle timeout ≈ 600s; client catches 401 and re-logs once.

Identity model: JWT only carries `u_sn` and `company_id`. The rest (`d_sn`, `ud_sn`) come from `POST /widget/deptChain/getUserDeptMap`. **`ud_sn` is called `s_sn` in that response** — easy mistake. See memory `nueip_id_model.md`.

Layer triple: most "employee" filters use `${c_sn}_${d_sn}_${ud_sn}`. **But the leave-application form's `Layer3` uses `u_sn` instead of `ud_sn`** — an outlier. `client.layerTriple()` builds the common form; the leave path hand-rolls Layer3 with `u_sn`.

Per-page fe-pno header: each section of nueip's UI is numbered. Captured today: 40 = leave, 44 = leave resource, 124 = attendance, 225 = approval. **Renumber and the server returns empty data without 4xx.** Hard-coded in each client method — if a list call returns mysteriously empty, suspect the fe-pno first.

Search cookies: list endpoints (attendance, leave) read filter params from cookies named `Search_<fe-pno>_*` rather than the request body. The client sets these before the POST. Don't strip these cookies during 401 retry blindly — `resolveIdentity()` doesn't touch them, but if you ever clear all cookies you lose the filter scope.

Popover-encoded values: many fields look like `<a class="popoverx" data-content="real value">popover label</a>`. The visible text is just the trigger ("說明", "0005"); the real value is in `data-content`. Use `popoverText()` in format.ts for `remark`. For `usr_name` / `c_date` the visible text *is* what you want, so plain stripHtml works.

Body content-type: most write endpoints use `application/x-www-form-urlencoded`. Leave submit (`action=add`) is the exception — multipart FormData because attachments. Leave delete is form-urlencoded again. Don't assume.

`{status:"fail"}` envelope: nueip returns 200 OK with a body like `{"status":"fail","message":"沒有刪除權限"}` on operational failures (permission denied, cooldown, validation rejection). `assertOk()` in client.ts converts this into `NueipError`, which `index.ts` then turns into an MCP `isError` response.

## Picking up where you left off

Check `/Users/casper/nix-lab/home/profiles/common/coding/claude/projects/-Users-casper-github-nueip-mpc/memory/MEMORY.md` — it indexes detailed per-endpoint notes from the original reverse-engineering session, including bodies, headers, gotchas, and observed quirks. Update the relevant file whenever you reverse-engineer a new endpoint.

## Open TODOs (in priority order)

1. **Cancel approved leave (銷假)** — endpoint URL is known (`/cancel_leave_record/api` + `/validate_cancel`), exact body shape needs one capture against an actually-approved leave (manager can't approve their own).
2. **Overtime / 加減班** — `/personal_overtime_application` page untouched.
3. **Employee-mode 補卡** — `/apply_work` flow for non-managers (current `correct_punch` is the manager-direct fast path).
4. **Modify-punch save** — manager edit modal found but save endpoint not captured.

## Running

```bash
cp .env.example .env   # fill NUEIP_PASSWORD
npm install
npm run build
npm test               # formatter snapshot tests
```

Wire into Claude Code via project-local `.mcp.json` (already configured). Server runs over stdio.
