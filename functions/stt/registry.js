const { ALLOWED_STT_PROVIDERS, STT_PROVIDER_OPENAI } = require("./constants");

function normalizeSttProviderValue(rawValue) {
  if (rawValue === undefined || rawValue === null) {
    return STT_PROVIDER_OPENAI;
  }
  const normalized = String(rawValue).trim().toLowerCase();
  if (!normalized) {
    return STT_PROVIDER_OPENAI;
  }
  return normalized;
}

function resolveSttProvider(rawValue) {
  const provider = normalizeSttProviderValue(rawValue);
  if (!ALLOWED_STT_PROVIDERS.has(provider)) {
    return {
      ok: false,
      code: "STT_PROVIDER_INVALID",
      provider,
    };
  }
  return {
    ok: true,
    provider,
  };
}

module.exports = {
  normalizeSttProviderValue,
  resolveSttProvider,
};
