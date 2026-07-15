const {
  STT_PROVIDER_OPENAI,
  STT_PROVIDER_GOOGLE,
} = require("./constants");

const STT_LANGUAGE_JA = "ja";
const STT_LANGUAGE_EN = "en";
const ALLOWED_STT_LANGUAGES = new Set([STT_LANGUAGE_JA, STT_LANGUAGE_EN]);

function normalizeSttLanguageValue(rawValue) {
  if (rawValue === undefined || rawValue === null) {
    return STT_LANGUAGE_JA;
  }
  const normalized = String(rawValue).trim().toLowerCase();
  if (!normalized) {
    return STT_LANGUAGE_JA;
  }
  return normalized;
}

function resolveSttLanguage(rawValue) {
  const language = normalizeSttLanguageValue(rawValue);
  if (!ALLOWED_STT_LANGUAGES.has(language)) {
    return {
      ok: false,
      code: "STT_LANGUAGE_INVALID",
      language,
    };
  }
  return {
    ok: true,
    language,
  };
}

function toGoogleLanguageCode(language) {
  return language === STT_LANGUAGE_EN ? "en-US" : "ja-JP";
}

function toOpenAiLanguage(language) {
  return language === STT_LANGUAGE_EN ? STT_LANGUAGE_EN : STT_LANGUAGE_JA;
}

function resolveProviderLanguage(provider, language) {
  if (provider === STT_PROVIDER_GOOGLE) {
    return toGoogleLanguageCode(language);
  }
  if (provider === STT_PROVIDER_OPENAI) {
    return toOpenAiLanguage(language);
  }
  return null;
}

module.exports = {
  STT_LANGUAGE_JA,
  STT_LANGUAGE_EN,
  ALLOWED_STT_LANGUAGES,
  normalizeSttLanguageValue,
  resolveSttLanguage,
  toGoogleLanguageCode,
  toOpenAiLanguage,
  resolveProviderLanguage,
};
