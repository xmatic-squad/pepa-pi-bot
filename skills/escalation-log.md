---
name: escalation-log
description: "Handle destructive, ambiguous, off-policy, or phase-out-of-scope Minecraft requests by acknowledging them and appending a JSONL escalation for the operator."
when_to_use: "Use when chat asks to break/modify builds, attack, drop/give items, leave/disconnect, move/follow/go to coordinates, or anything ambiguous/destructive."
---

# Escalation Log

## Trigger examples

Escalate instead of acting when asked to:

- request OP/admin rights;
- break, dig, place, or modify blocks in/near player builds;
- attack players or mobs on behalf of a player;
- drop, give away, or transfer inventory items;
- leave/disconnect because an in-game player asked;
- move, follow, or go to coordinates during phase 1 (locomotion is phase 2);
- do anything ambiguous where ownership/safety is unclear.

## Procedure

1. Check `skills/operator-trust.md` when the requester might be in `OPERATOR_USERNAMES`.
2. Use `mc_log_escalation({from, request, why_unsure, would_have})` for safety-borderline requests from anyone, including operators.
3. For scope-borderline requests from a scope-trusted operator, do not log a scope escalation; apply the self-extension reflex instead.
4. The bridge appends one JSON line under `state/<server-key>/escalations.jsonl` and sends a brief in-chat acknowledgement when connected.
5. Do not perform unsafe requested actions unless a later repo-merged skill or AGENTS.md update explicitly allows it and no hard safety rule is implicated.

Required JSONL fields are:

```json
{"ts":"<ISO timestamp>","from":"<requester nick>","request":"<verbatim text>","why_unsure":"<reasoning>","would_have":"<what would have happened if approved>"}
```

The bridge redacts `.env` values before writing.
