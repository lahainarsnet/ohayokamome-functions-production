const assert = require("assert");
const {
  buildRecognizerName,
  buildSpeechApiEndpoint,
  extractSafeGoogleErrorDiagnostics,
  extractTextFromGoogleResponse,
  normalizeGoogleError,
  transcribeWithGoogle,
} = require("./googleProvider");
const {
  STT_PROVIDER_GOOGLE,
  GOOGLE_STT_DEFAULT_MODEL,
  GOOGLE_STT_DEFAULT_LOCATION,
  GOOGLE_STT_API_TIMEOUT_MS,
} = require("./constants");

function createMockClient(recognizeImpl) {
  return {
    recognize: recognizeImpl,
  };
}

function runTests() {
  assert.strictEqual(
    buildRecognizerName("lahainarsnet-ohayokamome-live", "us"),
    "projects/lahainarsnet-ohayokamome-live/locations/us/recognizers/_",
  );
  assert.strictEqual(buildSpeechApiEndpoint("us"), "us-speech.googleapis.com");
  assert.strictEqual(
    buildSpeechApiEndpoint("global"),
    "speech.googleapis.com",
  );

  const diagnostics = extractSafeGoogleErrorDiagnostics({
    code: 3,
    message:
      "3 INVALID_ARGUMENT: model 'chirp_3' does not exist in the location named 'global'",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.BadRequest",
        fieldViolations: [
          {
            field: "config.model",
            description: "model chirp_3 is not available in global",
          },
        ],
      },
    ],
  });
  assert.strictEqual(diagnostics.grpcCode, 3);
  assert.ok(diagnostics.messageSummary.includes("INVALID_ARGUMENT"));
  assert.strictEqual(diagnostics.fieldViolations.length, 1);
  assert.strictEqual(diagnostics.fieldViolations[0].field, "config.model");

  assert.strictEqual(
    extractTextFromGoogleResponse({
      results: [
        { alternatives: [{ transcript: "おはよう" }] },
        { alternatives: [{ transcript: "カモメ" }] },
      ],
    }),
    "おはよう カモメ",
  );
  assert.strictEqual(extractTextFromGoogleResponse({ results: [] }), "");
  assert.strictEqual(
    extractTextFromGoogleResponse({
      results: [{ alternatives: [{ transcript: "" }] }],
    }),
    "",
  );
  assert.strictEqual(
    extractTextFromGoogleResponse({
      results: [{ alternatives: [{ transcript: "  こんにちは  " }] }],
    }),
    "こんにちは",
  );

  assert.strictEqual(normalizeGoogleError({ code: 7 }), "GOOGLE_STT_PERMISSION");
  assert.strictEqual(normalizeGoogleError({ code: 8 }), "GOOGLE_STT_QUOTA");
  assert.strictEqual(normalizeGoogleError({ code: 4 }), "GOOGLE_STT_TIMEOUT");
  assert.strictEqual(normalizeGoogleError({ code: 3 }), "GOOGLE_STT_INVALID_AUDIO");
  assert.strictEqual(
    normalizeGoogleError({ message: "PERMISSION_DENIED: denied" }),
    "GOOGLE_STT_PERMISSION",
  );
  assert.strictEqual(
    normalizeGoogleError({ message: "RESOURCE_EXHAUSTED: quota" }),
    "GOOGLE_STT_QUOTA",
  );
  assert.strictEqual(
    normalizeGoogleError({ message: "DEADLINE_EXCEEDED: timeout" }),
    "GOOGLE_STT_TIMEOUT",
  );
  assert.strictEqual(
    normalizeGoogleError({ message: "INVALID_ARGUMENT: bad audio" }),
    "GOOGLE_STT_INVALID_AUDIO",
  );
  assert.strictEqual(normalizeGoogleError(new Error("unknown")), "GOOGLE_STT_ERROR");
}

async function runAsyncTests() {
  const audioBuffer = Buffer.from("fake-audio");
  const mimeType = "audio/mp4";
  const receivedBytes = audioBuffer.length;
  const projectId = "lahainarsnet-ohayokamome-live";
  let capturedRequest;

  const successClient = createMockClient(async (request) => {
    capturedRequest = request;
    return [
      {
        results: [{ alternatives: [{ transcript: "認識テキスト" }] }],
      },
    ];
  });

  const successResult = await transcribeWithGoogle({
    audioBuffer,
    mimeType,
    receivedBytes,
    projectId,
    speechClientFactory: () => successClient,
  });

  assert.strictEqual(successResult.ok, true);
  assert.strictEqual(successResult.text, "認識テキスト");
  assert.strictEqual(successResult.provider, STT_PROVIDER_GOOGLE);
  assert.strictEqual(successResult.model, GOOGLE_STT_DEFAULT_MODEL);
  assert.strictEqual(successResult.location, GOOGLE_STT_DEFAULT_LOCATION);
  assert.strictEqual(typeof successResult.apiLatencyMs, "number");
  assert.strictEqual(
    capturedRequest.recognizer,
    buildRecognizerName(projectId, GOOGLE_STT_DEFAULT_LOCATION),
  );
  assert.deepStrictEqual(capturedRequest.config, {
    autoDecodingConfig: {},
    languageCodes: ["ja-JP"],
    model: GOOGLE_STT_DEFAULT_MODEL,
    features: { enableAutomaticPunctuation: true },
  });
  assert.ok(Buffer.isBuffer(capturedRequest.content));

  const emptyResult = await transcribeWithGoogle({
    audioBuffer,
    mimeType,
    receivedBytes,
    projectId,
    speechClientFactory: () =>
      createMockClient(async () => [{ results: [] }]),
  });
  assert.strictEqual(emptyResult.ok, true);
  assert.strictEqual(emptyResult.text, "");

  const permissionError = await transcribeWithGoogle({
    audioBuffer,
    mimeType,
    receivedBytes,
    projectId,
    speechClientFactory: () =>
      createMockClient(async () => {
        const error = new Error("PERMISSION_DENIED");
        error.code = 7;
        throw error;
      }),
  });
  assert.strictEqual(permissionError.ok, false);
  assert.strictEqual(permissionError.code, "GOOGLE_STT_PERMISSION");

  const quotaError = await transcribeWithGoogle({
    audioBuffer,
    mimeType,
    receivedBytes,
    projectId,
    speechClientFactory: () =>
      createMockClient(async () => {
        const error = new Error("RESOURCE_EXHAUSTED");
        error.code = 8;
        throw error;
      }),
  });
  assert.strictEqual(quotaError.ok, false);
  assert.strictEqual(quotaError.code, "GOOGLE_STT_QUOTA");

  const timeoutError = await transcribeWithGoogle({
    audioBuffer,
    mimeType,
    receivedBytes,
    projectId,
    speechClientFactory: () =>
      createMockClient(async () => {
        const error = new Error("DEADLINE_EXCEEDED");
        error.code = 4;
        throw error;
      }),
  });
  assert.strictEqual(timeoutError.ok, false);
  assert.strictEqual(timeoutError.code, "GOOGLE_STT_TIMEOUT");

  const invalidAudioError = await transcribeWithGoogle({
    audioBuffer,
    mimeType,
    receivedBytes,
    projectId,
    speechClientFactory: () =>
      createMockClient(async () => {
        const error = new Error("INVALID_ARGUMENT");
        error.code = 3;
        throw error;
      }),
  });
  assert.strictEqual(invalidAudioError.ok, false);
  assert.strictEqual(invalidAudioError.code, "GOOGLE_STT_INVALID_AUDIO");

  const sdkInitError = await transcribeWithGoogle({
    audioBuffer,
    mimeType,
    receivedBytes,
    projectId,
    speechClientFactory: () => {
      throw new Error("SDK_INIT_FAILED");
    },
  });
  assert.strictEqual(sdkInitError.ok, false);
  assert.strictEqual(sdkInitError.code, "GOOGLE_STT_ERROR");

  const missingProject = await transcribeWithGoogle({
    audioBuffer,
    mimeType,
    receivedBytes,
    projectId: "",
    speechClientFactory: () => successClient,
  });
  assert.strictEqual(missingProject.ok, false);
  assert.strictEqual(missingProject.code, "GOOGLE_STT_ERROR");

  const logLines = [];
  const logger = {
    warn: (message, fields) => {
      logLines.push({ message, fields });
    },
    error: (message, fields) => {
      logLines.push({ message, fields });
    },
  };
  await transcribeWithGoogle({
    audioBuffer,
    mimeType,
    receivedBytes,
    projectId,
    logger,
    speechClientFactory: () =>
      createMockClient(async () => {
        const error = new Error("PERMISSION_DENIED");
        error.code = 7;
        throw error;
      }),
  });
  const serializedLogs = JSON.stringify(logLines);
  assert.ok(!serializedLogs.includes("fake-audio"));
  assert.ok(!serializedLogs.includes("認識テキスト"));
  assert.ok(!serializedLogs.includes("api-key"));
  assert.ok(logLines.some((entry) => entry.fields?.errorCode === "GOOGLE_STT_PERMISSION"));

  const diagnosticLogLines = [];
  const diagnosticLogger = {
    warn: (message, fields) => {
      diagnosticLogLines.push({ message, fields });
    },
  };
  await transcribeWithGoogle({
    audioBuffer,
    mimeType,
    receivedBytes,
    projectId,
    logger: diagnosticLogger,
    speechClientFactory: () =>
      createMockClient(async () => {
        const error = new Error(
          "3 INVALID_ARGUMENT: model 'chirp_3' does not exist in the location named 'global'",
        );
        error.code = 3;
        error.details = [
          {
            "@type": "type.googleapis.com/google.rpc.BadRequest",
            fieldViolations: [
              {
                field: "config.model",
                description: "model chirp_3 is not available in global",
              },
            ],
          },
        ];
        throw error;
      }),
  });
  const diagnosticEntry = diagnosticLogLines.find(
    (entry) => entry.message === "transcribeExperiment: GOOGLE_STT_ERROR",
  );
  assert.ok(diagnosticEntry);
  assert.strictEqual(diagnosticEntry.fields.grpcCode, 3);
  assert.ok(diagnosticEntry.fields.messageSummary.includes("INVALID_ARGUMENT"));
  assert.strictEqual(diagnosticEntry.fields.fieldViolations[0].field, "config.model");
  assert.ok(!JSON.stringify(diagnosticLogLines).includes("fake-audio"));

  const slowClient = createMockClient(
    () =>
      new Promise((resolve) => {
        setTimeout(
          () => resolve([{ results: [{ alternatives: [{ transcript: "late" }] }] }]),
          GOOGLE_STT_API_TIMEOUT_MS + 50,
        );
      }),
  );
  const timedOut = await transcribeWithGoogle({
    audioBuffer,
    mimeType,
    receivedBytes,
    projectId,
    timeoutMs: 20,
    speechClientFactory: () => slowClient,
  });
  assert.strictEqual(timedOut.ok, false);
  assert.strictEqual(timedOut.code, "GOOGLE_STT_TIMEOUT");
}

runTests();
runAsyncTests()
  .then(() => {
    console.log("stt/googleProvider.test.js: all tests passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
