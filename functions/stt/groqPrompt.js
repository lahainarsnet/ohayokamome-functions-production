const GROQ_MAX_PROMPT_TOKENS = 224;

function estimatePromptTokens(text) {
  if (typeof text !== "string" || text.length === 0) {
    return 0;
  }
  let tokens = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (
      (code >= 0x3000 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      tokens += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      tokens += 0.25;
      continue;
    }
    tokens += 0.4;
  }
  return Math.ceil(tokens);
}

function fitPromptToTokenBudget(text, maxTokens) {
  if (estimatePromptTokens(text) <= maxTokens) {
    return { prompt: text, truncated: false };
  }

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = text.slice(0, mid);
    if (estimatePromptTokens(candidate) <= maxTokens) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  const fitted = text.slice(0, low);
  return {
    prompt: fitted,
    truncated: fitted.length < text.length,
  };
}

function buildGroqTranscriptionPrompt({ userPrompt }) {
  if (typeof userPrompt !== "string") {
    return { prompt: null, truncated: false, estimatedTokens: 0 };
  }
  const trimmed = userPrompt.trim();
  if (trimmed === "") {
    return { prompt: null, truncated: false, estimatedTokens: 0 };
  }

  const fitted = fitPromptToTokenBudget(trimmed, GROQ_MAX_PROMPT_TOKENS);
  return {
    prompt: fitted.prompt,
    truncated: fitted.truncated,
    estimatedTokens: estimatePromptTokens(fitted.prompt),
  };
}

module.exports = {
  GROQ_MAX_PROMPT_TOKENS,
  estimatePromptTokens,
  buildGroqTranscriptionPrompt,
};
