---
name: dogfood
description: Systematically explore and test a mobile app on iOS/Android with agent-device to find bugs, UX issues, and other problems. Use when asked to dogfood, QA, exploratory test, find issues, bug hunt, or test this app on mobile.
allowed-tools: Bash(agent-device:*), Bash(npx agent-device:*)
---

# Dogfood

Router for exploratory QA. Private setup before using this skill:

```bash
agent-device --version
```

If that fails, stop and tell the user to expose a trusted `agent-device` binary on PATH or approve an exact-version npm command. This skill intentionally keeps allowed tools restricted to `agent-device` and `npx agent-device`.

Require `agent-device >= 0.14.0`; older CLIs lack these help topics. If older, stop and tell the user to upgrade the trusted install or approve an exact-version npm command. Do not run `npm install -g agent-device@latest` or `npx -y agent-device@latest` autonomously, and do not include version/upgrade commands in final plans.

Read current CLI guidance:

```bash
agent-device help dogfood
```

Loop: open app -> snapshot -i + screenshot -> explore flows -> capture evidence per issue -> close (`close --shutdown` if your session booted a local simulator or emulator, unless the user asks to keep it running).

Target app is required; infer platform or ask. Findings must come from runtime behavior, not source reads. Let `help dogfood` provide exact report shape, evidence commands, and current workflow guidance.
