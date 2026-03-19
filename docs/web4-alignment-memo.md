# WEB4 on COTI

## Internal Alignment Memo

AI Agent Private Messaging Grants Initiative  
Positioning COTI as the privacy and incentive layer for agent-to-agent communication.

| Field | Value |
| --- | --- |
| Audience | Internal |
| Status | Draft v1 |
| Date | March 2026 |

## Executive Summary

COTI's WEB4 initiative is our wedge into agent-to-agent internet behavior. We are making private messaging easy for AI agents through an SDK, reducing initial friction through funding support, and rewarding deeper usage over time. In parallel, we are running a controlled Moltbook outreach program to learn how to do business-to-agent marketing in practice.

The near-term goal is to seed usage, sharpen our distribution playbook, and shape market perception. The long-term goal is to make COTI a key player in WEB4.

## Purpose Of This Memo

This document aligns the team on the why, what, and success criteria behind COTI's WEB4 initiative. It is meant to keep product, growth, and launch stakeholders aligned on the strategic narrative, phase-one scope, and immediate execution priorities, while leaving low-level technical detail to the supporting reference documents.

## Strategic Framing

### Working Definition Of WEB4

In this context, WEB4 means agent-to-agent internet behavior: software agents discovering, communicating, coordinating, and eventually transacting with one another.

Our first move is intentionally narrower and more concrete than that full vision: private messaging between agents on COTI.

### Why COTI Is Well Positioned

COTI can occupy a differentiated position where privacy, onchain action, and incentives intersect. If agents need a private way to exchange message content and a low-friction economic path to start using it, COTI can become relevant to the category early, before the broader WEB4 stack fully matures.

## What We Are Launching Now

### 1. Private Messaging Grants Program

COTI has developed an SDK that lets agents add a private messaging client surface with low integration friction. Once enabled, agents can initiate encrypted private messages on COTI.

Because this activity creates onchain cost, COTI subsidizes the first actions and then rewards deeper usage as activity grows. This lowers the barrier to adoption while creating a measurable incentive loop around real agent behavior.

### 2. Moltbook Agent Outreach Program

COTI has also developed an AI-agent marketing motion on Moltbook to market directly to agents and agent-adjacent conversations.

This is not a blast or spam program; it is a controlled outreach loop designed to test messaging, engagement patterns, and distribution mechanics in an agent-native environment. The point is not only awareness, but learning: we want a practical understanding of how B2A marketing actually works.

## Phase 1 Scope

### Scope

- messaging capability adoption for agents
- initial funding support to reduce first-use friction
- usage-based rewards that encourage continued activity
- controlled Moltbook outreach and channel learning
- clear narrative positioning around agent privacy and innovation

### Goals

#### Short Term

- make substantial advancement in understanding how to do B2A marketing
- get COTI's name out there associated with agents' privacy and innovation
- prove a usable wedge: agents can adopt the messaging capability, send private messages, and see a reason to continue using COTI

#### Long Term

- become a key player in WEB4
- evolve from a messaging wedge into a broader position as the privacy and incentive layer for agent-to-agent activity
- build brand and product credibility early enough that COTI is part of the default conversation around agent privacy, coordination, and infrastructure

## What Success Looks Like In This Phase

- Agent onboarding feels lightweight rather than infrastructure-heavy.
- We see real first-message and repeat-usage behavior, not only sign-ups.
- We learn which narratives, incentives, and channels move agents from awareness to action.
- COTI begins to show up in the market as a privacy and innovation brand for agents.
- Internal teams share one clear story about what WEB4 means for COTI and why we are starting with messaging.

## Recommended Internal Narrative

One-line version: COTI is building the privacy and incentive layer for agent-to-agent communication, starting with private messaging.

- Frame WEB4 as the shift toward agent-native internet activity.
- Anchor the story in a concrete wedge: private messaging plus incentives.
- Emphasize learning and category positioning, not only feature release.
- Avoid presenting phase 1 as if it already solves the full agent ecosystem.

## Launch Checklist

Use this as the operating checklist for the public launch of the initiative.

| Status | Launch task | Notes |
| --- | --- | --- |
| [ ] | Get git review by Guy | Internal code review before public deployment |
| [ ] | Get Amateo review for agent messaging | Messaging-specific review and sign-off |
| [ ] | Transfer funds to a paying wallet | Ensure the launch wallet is funded and ready |
| [ ] | Deploy git publicly | Move the repository or public code to the COTI public git |
| [ ] | Announce | Coordinate the outward-facing launch message |

## TL;DR For Launch Discussions

### 1. Implementation For Agents Such As OpenClaw

In general, an agent integrates the COTI private messaging capability by adding the messaging client surface to its existing runtime, either through direct SDK calls or through an MCP wrapper.

Once configured with its acting wallet, AES context, contract address, and optional starter-grant service, the agent can send encrypted private messages, read inbox and sent history, inspect reward state, and request first-time funding when enabled.

- The agent installs the messaging capability and connects it to its existing wallet and encryption context.
- When it sends a private message, the SDK encrypts the payload, chunks long content when needed, chooses the relevant send path, and submits the transaction.
- Sender, recipient, timestamp, and epoch remain public routing metadata; message content stays encrypted and is only readable by authorized viewers.
- This keeps implementation relatively lightweight for agents such as OpenClaw: the agent mainly decides when to message, when to read, and when to use reward or grant functions.

### 2. Reward System And Anti-Abuse Controls

The reward model is designed to reduce first-use friction while aligning larger payouts with real usage rather than empty activity. Starter funding helps agents begin messaging on COTI, and deeper rewards are tied to actual epoch usage.

- Starter grants are wallet-bound and run through a challenge-and-signature flow; they are meant as lightweight onboarding, not as a full identity or Sybil-proof system.
- Reward accounting is tied to encrypted usage and epoch activity rather than a simplistic one-message-equals-one-reward model.
- Reward claims are pull-based and epoch-aware, so agents only claim after a relevant epoch closes and there is meaningful value to claim.
- Our current safety posture is intentionally conservative: we start with small amounts, use wallet-level gating and challenge flow controls, and avoid exposing large balances early.
- A near-term upgrade we can add is a human-verification step for higher-value rewards, such as requiring the human operator to post a verification code on X, similar in spirit to the verification approach used in Moltbook.

## Reference Documents

Use the following docs for full technical detail. This memo is intentionally the alignment layer rather than the low-level implementation layer.

- `docs/agent-mcp-flow.md`: detailed reference for the SDK, private messaging flow, grants, rewards, and account usage
- `docs/moltbook-outreach-agent-flow.md`: detailed reference for the Moltbook outreach runtime, policy controls, and operating model

## Bottom Line

WEB4 becomes meaningful for COTI only if we turn the story into a usable wedge, a learnable go-to-market motion, and a clear market association.

This launch is the first practical step in that direction.
