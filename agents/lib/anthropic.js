// Anthropic API wrapper with tool-use loop + cost tracking
const Anthropic = require('@anthropic-ai/sdk');

const MODEL_PRICING_USD = {
  // Per million tokens (input / output)
  'claude-opus-4-7':   { in: 15.00, out: 75.00 },
  'claude-sonnet-4-6': {  in: 3.00, out: 15.00 },
  'claude-haiku-4-5':  {  in: 1.00, out:  5.00 },
};

function priceCall(model, usage) {
  const p = MODEL_PRICING_USD[model] || MODEL_PRICING_USD['claude-sonnet-4-6'];
  const tIn  = usage?.input_tokens  || 0;
  const tOut = usage?.output_tokens || 0;
  return {
    tokensIn: tIn,
    tokensOut: tOut,
    costUsd: (tIn / 1e6) * p.in + (tOut / 1e6) * p.out,
  };
}

class AgentLoop {
  constructor({ apiKey, model, system, tools, toolImpls, maxTurns = 25, costCapUsd = 5 }) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
    this.system = system;
    this.tools = tools;
    this.toolImpls = toolImpls;
    this.maxTurns = maxTurns;
    this.costCapUsd = costCapUsd;
    this.totalCostUsd = 0;
    this.totalTokensIn = 0;
    this.totalTokensOut = 0;
    this.messages = [];
  }

  async run(initialUserMessage) {
    this.messages.push({ role: 'user', content: initialUserMessage });
    let turn = 0;
    while (turn < this.maxTurns) {
      turn++;
      if (this.totalCostUsd >= this.costCapUsd) {
        return { stopReason: 'cost_cap', turn, cost: this.totalCostUsd };
      }

      const resp = await this.client.messages.create({
        model: this.model,
        max_tokens: 8000,
        system: this.system,
        tools: this.tools,
        messages: this.messages,
      });

      const priced = priceCall(this.model, resp.usage);
      this.totalCostUsd += priced.costUsd;
      this.totalTokensIn += priced.tokensIn;
      this.totalTokensOut += priced.tokensOut;

      this.messages.push({ role: 'assistant', content: resp.content });

      if (resp.stop_reason === 'end_turn' || resp.stop_reason === 'stop_sequence') {
        return { stopReason: 'end_turn', turn, cost: this.totalCostUsd, finalContent: resp.content };
      }

      if (resp.stop_reason !== 'tool_use') {
        return { stopReason: resp.stop_reason, turn, cost: this.totalCostUsd };
      }

      const toolResults = [];
      for (const block of resp.content) {
        if (block.type !== 'tool_use') continue;
        const impl = this.toolImpls[block.name];
        let result;
        if (!impl) {
          result = { error: `Unknown tool: ${block.name}` };
        } else {
          try {
            result = await impl(block.input);
          } catch (err) {
            result = { error: err.message };
          }
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      }
      this.messages.push({ role: 'user', content: toolResults });
    }
    return { stopReason: 'max_turns', turn, cost: this.totalCostUsd };
  }
}

module.exports = { AgentLoop, priceCall, MODEL_PRICING_USD };
