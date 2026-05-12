# nueip-mcp

An MCP (Model Context Protocol) server that exposes [nueip.com](https://www.nueip.com/)'s HR / attendance API as tools an LLM client (Claude Code, Claude Desktop, etc.) can call.

Lets you say things like *"clock me in at the office"*, *"how much 特休 do I have before it expires?"*, *"approve all of Alice's 補卡 from last week"* — and have it actually happen.

> [!CAUTION]
> Unofficial. Built by reverse-engineering nueip's web app. Not endorsed by NUEIP and likely violates their terms of service for automated access. Your account may be flagged or restricted. **Use at your own risk** — and don't run anything destructive (leave applications, approvals) on production without testing on yourself first.

## What it can do

| Category | Tools |
|---|---|
| Punching | `clock_in`, `clock_out` (lat/lng or named preset), `punch_status` |
| Identity | `whoami`, `list_colleagues` (find someone's u_sn / ud_sn for 職代) |
| Attendance | `list_attendance` (per-day summary with status, holiday, punches) |
| Leave – read | `list_leaves`, `leave_balance` (with per-batch expiry + `expiring_soon`), `leave_types`, `remaining_leave_hours` |
| Leave – write | `apply_leave`, `delete_pending_leaves` (two-step validate + commit) |
| Punch corrections | `correct_punch` (manager-direct add) |
| Approval workflow | `list_pending_approvals`, `respond_to_approvals` (agree/deny, batched) |
| Setup | `list_location_presets` |

Output is normalised — nueip's responses come back with HTML wrappers, popover-encoded reasons, duplicate `hours` / `hours_hrmin` field pairs, and other UI cruft; the tools strip that down to compact JSON.

## Requirements

- Node 20+
- A nueip account
- Claude Code (or any MCP-capable client speaking stdio)

## Setup

```bash
git clone <this-repo>
cd nueip-mcp
npm install
npm run build

cp .env.example .env
$EDITOR .env                 # fill NUEIP_PASSWORD
cp presets.example.json presets.json
$EDITOR presets.json         # set your office lat/lng
```

`.env`:

```
NUEIP_COMPANY_CODE=...       # the company code you type at the nueip login page
NUEIP_EMPLOYEE_ID=...        # your employee number
NUEIP_PASSWORD=...
NUEIP_PRESETS_PATH=./presets.json
```

### Wire into Claude Code

The repo already includes a project-local `.mcp.json` that registers this server. Open Claude Code in the project directory and it'll prompt you to allow the `nueip` MCP server on first launch.

To use globally instead, copy the `nueip` entry into your own `~/.claude.json`'s `mcpServers` and update the path:

```jsonc
{
  "mcpServers": {
    "nueip": {
      "command": "node",
      "args": [
        "--env-file=/abs/path/to/nueip-mcp/.env",
        "/abs/path/to/nueip-mcp/dist/index.js"
      ]
    }
  }
}
```

## Usage examples

After connecting, ask Claude:

- *"Clock me in at the office"* → `clock_in({preset:"office"})`
- *"How much 特休 do I have left? Anything expiring soon?"* → `leave_balance` → reports the `expiring_soon` batch
- *"Show today's attendance"* → `list_attendance`
- *"File a half-day 事假 next Wednesday morning, Alice as my substitute"* → `list_colleagues` → `leave_types` → `apply_leave`
- *"What 補卡 are waiting for my approval?"* → `list_pending_approvals({type:"attendance"})`
- *"Approve all of Alice's"* → `respond_to_approvals({type:"attendance", act:"agree", targets:[…]})`

## Operational caveats

- **Session idle timeout ≈ 10 minutes.** Client transparently re-logs on 401, but expect a one-shot delay after an idle gap.
- **30-second cooldown between punches.** Reattempting too quickly returns `30秒內請勿重複打卡` (mapped to `NueipError`).
- **GPS punch needs to be inside your company's geofence.** Otherwise the server rejects with a status message.
- **Approval is irreversible.** Once you `respond_to_approvals` with `act:"agree"`, the server refuses any cancel/revert action.
- **`apply_leave` creates a real pending record.** Use `delete_pending_leaves` to retract while it's still 簽核中.
- **`fe-pno` page numbers are hard-coded** (40 = leave, 44 = balance, 124 = attendance, 225 = approval). If nueip renumbers, list calls start returning empty without a 4xx — known fragility.

## What's not implemented

- 銷假 (cancel an already-approved leave) — endpoint URL known, body shape needs one more capture pass
- Overtime / 加減班 application
- Employee-mode 補卡 via `/apply_work` (current `correct_punch` is the manager-direct fast path)
- Modify-punch save (manager edit modal)

PRs welcome.

## Development

```bash
npm run typecheck    # tsc --noEmit
npm test             # snapshot tests over fixed nueip responses
npm run build
```

See `CLAUDE.md` for the codebase walkthrough — endpoint quirks (the `Layer3 = u_sn` outlier, popover-encoded `data-content`, identity model with `s_sn` aliasing `ud_sn`, etc.) and where in `src/` each concern lives.

## License

MIT — see `LICENSE`.
