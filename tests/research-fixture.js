"use strict";

function agentPayload() {
  return {
    schema_version: "2.1",
    export: {
      mode: "full_history",
      exported_at: "2026-09-24T10:00:00.000Z",
      extension_version: "3.0.0",
      source: { site: "arena.ai", mode: "agent", url: "https://arena.ai/c/abc-123" }
    },
    session: {
      session_id: "s-1",
      conversation_key: "c:abc-123",
      title: "Plan a weekend in Cottbus",
      started_at: "2026-09-24T09:55:00.000Z",
      orchestrator_model: null
    },
    messages: [
      { role: "user", turn_index: 0, content: [{ type: "text", text: "Plan a weekend in Cottbus" }] },
      {
        role: "assistant",
        turn_index: 1,
        content: [
          { type: "thinking", text: "I should check the weather first." },
          { type: "tool_call", tool_name: "web_search", call_id: "call-1", arguments: { q: "Cottbus weather" }, output: { text: "sunny, 22 C" }, status: "success" },
          { type: "text", text: "Saturday looks sunny. Walk around the Branitz park." },
          { type: "artifact", title: "plan.md", artifact_type: "text/markdown", content_or_url: "data:text/markdown;base64,IyBQbGFu", archive_path: "files/plan.md", bytes: 120 }
        ]
      }
    ],
    battles: [],
    attribution_samples: [],
    summary: {},
    meta: {
      completeness: "full",
      warnings: ["An attachment download failed."],
      completeness_detail: { status: "full" }
    }
  };
}

function battlePayload() {
  return {
    schema_version: "2.1",
    export: {
      mode: "full_history",
      exported_at: "2026-09-23T18:00:00.000Z",
      extension_version: "3.0.0",
      source: { site: "arena.ai", mode: "battle", url: "https://arena.ai/c/def-456" }
    },
    session: { session_id: "s-2", conversation_key: "c:def-456", title: "Which answer is better?", started_at: "2026-09-23T17:50:00.000Z" },
    messages: [],
    battles: [
      {
        evaluation_id: "e-1",
        mode: "battle",
        prompt: "Explain async Rust",
        outcome: "a_wins",
        vote_choice: "A",
        winner: "A",
        winner_model: "alpha-1",
        contestants: [
          {
            lane: "A",
            model: "alpha-1",
            model_source: "arena_reveal",
            model_identity_verified: true,
            response: "Alpha explains ownership and futures.",
            reasoning: "Start with the runtime.",
            tool_calls: [{ tool_name: "web_search", arguments: { q: "tokio" }, output: "tokio docs" }],
            files: [{ path: "a.png", bytes: 10, media_type: "image/png" }]
          },
          { lane: "B", model: "beta-1", model_source: "page_selection", model_identity_verified: false, response: "Beta talks about pinning." }
        ],
        vote: { choice: "A", source: "manual" }
      },
      {
        evaluation_id: "e-2",
        mode: "battle",
        prompt: "Explain ownership",
        outcome: "pending",
        contestants: [
          { lane: "A", model: "alpha-1", model_identity_verified: true, response: "Alpha on ownership." },
          { lane: "B", model: "beta-1", model_source: "page_selection", response: "Beta on ownership." }
        ]
      }
    ],
    attribution_samples: [],
    summary: {},
    meta: { completeness: "partial", warnings: [], completeness_detail: { status: "partial" } }
  };
}

module.exports = { agentPayload, battlePayload };
