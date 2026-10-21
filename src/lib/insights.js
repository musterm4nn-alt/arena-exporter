/* Pure aggregation for the Insights view. Everything is derived from local
 * library records; model names are captured claims, not verified identities,
 * unless the record says Arena revealed them.
 */
var AE = AE || {};
(function () {
  "use strict";

  const BALLOT = ["a_wins", "b_wins", "both_good", "neither_good"];

  function monthKey(date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    return year + "-" + month;
  }

  function lastMonths(now, count) {
    const months = [];
    const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    for (let i = count - 1; i >= 0; i--) {
      const date = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() - i, 1));
      months.push(monthKey(date));
    }
    return months;
  }

  function increment(bucket, key) {
    if (!key) return;
    bucket[key] = (bucket[key] || 0) + 1;
  }

  function insights(records, options) {
    options = options || {};
    const now = options.now ? new Date(options.now) : new Date();
    const list = Array.isArray(records) ? records : [];
    const totals = {
      conversations: list.length,
      turns: 0,
      messages: 0,
      assistant_messages: 0,
      tool_calls: 0,
      files: 0,
      reasoning_chars: 0,
      payload_bytes: 0
    };
    const modes = {};
    const votes = { a_wins: 0, b_wins: 0, both_good: 0, neither_good: 0 };
    const completeness = {};
    const tools = {};
    const models = Object.create(null);
    const activityMap = {};
    let ballots = 0, pending = 0, notApplicable = 0, manualVotes = 0, unrevealedBattles = 0;

    list.forEach(function (record) {
      if (!record) return;
      const counts = record.counts || {};
      totals.turns += Number(record.turns) || 0;
      totals.messages += Number(counts.messages) || 0;
      totals.assistant_messages += Number(counts.assistant_messages) || 0;
      totals.tool_calls += Number(counts.tool_calls) || 0;
      totals.files += Number(counts.files) || 0;
      totals.reasoning_chars += Number(counts.thinking_chars) || 0;
      totals.payload_bytes += Number(record.payload_bytes) || 0;
      increment(modes, record.mode || "unknown");
      increment(completeness, record.completeness || "unknown");
      const month = /^\d{4}-\d{2}/.exec(String(record.updated_at || ""));
      if (month) increment(activityMap, month[0]);

      (record.messages || []).forEach(function (message) {
        (message.blocks || []).forEach(function (block) {
          if (block.type === "tool_call" && block.tool_name) increment(tools, block.tool_name);
        });
      });

      (record.battles || []).forEach(function (battle) {
        const outcome = String(battle.outcome || "");
        if (BALLOT.indexOf(outcome) !== -1) {
          votes[outcome]++;
          ballots++;
        } else if (outcome === "pending") {
          pending++;
        } else {
          notApplicable++;
        }
        if (battle.vote_source === "manual") manualVotes++;
        let winnerLane = null;
        if (outcome === "a_wins") winnerLane = "A";
        if (outcome === "b_wins") winnerLane = "B";
        let named = false;
        (battle.contestants || []).forEach(function (contestant) {
          if (contestant.tool_calls) {
            contestant.tool_calls.forEach(function (call) {
              if (call.tool_name) increment(tools, call.tool_name);
            });
          }
          if (!contestant.model) return;
          named = true;
          const key = contestant.model;
          if (!models[key]) models[key] = { name: key, appearances: 0, wins: 0, verified: false };
          models[key].appearances++;
          if (contestant.verified) models[key].verified = true;
          if (winnerLane && contestant.lane === winnerLane) models[key].wins++;
        });
        if (!named && (battle.contestants || []).length) unrevealedBattles++;
      });
    });

    const months = lastMonths(now, 12).map(function (month) {
      return { month: month, count: activityMap[month] || 0 };
    });
    const earlier = Object.keys(activityMap).filter(function (key) { return months.every(function (m) { return m.month !== key; }); })
      .reduce(function (sum, key) { return sum + activityMap[key]; }, 0);

    return {
      generated_at: now.toISOString(),
      totals: totals,
      modes: Object.keys(modes).sort(function (a, b) { return modes[b] - modes[a]; }).map(function (mode) { return { mode: mode, count: modes[mode] }; }),
      completeness: Object.keys(completeness).sort(function (a, b) { return completeness[b] - completeness[a]; }).map(function (status) { return { status: status, count: completeness[status] }; }),
      votes: {
        outcomes: votes,
        ballots: ballots,
        pending: pending,
        not_applicable: notApplicable,
        manual_votes: manualVotes,
        unrevealed_battles: unrevealedBattles
      },
      models: Object.keys(models).map(function (key) { return models[key]; })
        .sort(function (a, b) { return b.appearances - a.appearances || String(a.name).localeCompare(String(b.name)); })
        .slice(0, 50),
      activity: { months: months, earlier: earlier },
      tools: Object.keys(tools).sort(function (a, b) { return tools[b] - tools[a]; }).slice(0, 12)
        .map(function (tool) { return { tool: tool, count: tools[tool] }; })
    };
  }

  AE.insights = insights;
  if (typeof module !== "undefined" && module.exports) module.exports = insights;
})();
