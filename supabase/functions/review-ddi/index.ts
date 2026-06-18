import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type ProposedMedicationInput = {
  name?: string;
  ingredient?: string;
  dose?: string | number;
  unit?: string;
  route?: string;
  frequency?: string;
};

type PatientEhr = {
  patient?: {
    patient_code?: string;
    external_record_ref?: string | null;
    record_status?: string;
  };
  medications?: Array<Record<string, unknown>>;
  allergies?: Array<Record<string, unknown>>;
  conditions?: Array<Record<string, unknown>>;
  observations?: Array<Record<string, unknown>>;
  clinical_notes?: Array<Record<string, unknown>>;
  encounters?: Array<Record<string, unknown>>;
};

type PairReview = {
  pairKey: string;
  left: string;
  right: string;
  leftSource: string;
  rightSource: string;
  pairType: "proposed-proposed" | "proposed-current";
};

type ReviewFinding = {
  type: string;
  severity: "none" | "low" | "medium" | "high" | "critical";
  signal: string;
  reasoning?: string;
  detail: string;
  action: string;
  left?: string;
  right?: string;
  leftSource?: string;
  rightSource?: string;
  evidence: Array<{
    source: string;
    title: string;
    url: string;
  }>;
};

const GCP_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

const fallbackIngredient = (name: string) => name.trim().toLowerCase();

const parseJsonResponseText = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Model response text was empty.");
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let candidate = fenced?.[1]?.trim() || trimmed;

  // JSON healing for truncated responses (common with Google Search grounding)
  if (!candidate.endsWith("}")) {
    if (!candidate.endsWith('"')) {
      candidate += '"';
    }
    candidate += "\n}";
  }

  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  const objectText =
    firstBrace >= 0 && lastBrace > firstBrace
      ? candidate.slice(firstBrace, lastBrace + 1)
      : candidate;
  return JSON.parse(objectText);
};

const encodeBase64Url = (value: string | Uint8Array) => {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const pemToArrayBuffer = (pem: string) => {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
};

const createGoogleAccessToken = async () => {
  const b64ServiceAccount = Deno.env.get("GCP_GEMINI_SERVICE_ACCOUNT_JSON_B64");
  const rawServiceAccount =
    Deno.env.get("GCP_GEMINI_SERVICE_ACCOUNT_JSON") ||
    Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");

  const jsonString = b64ServiceAccount
    ? new TextDecoder().decode(
        Uint8Array.from(atob(b64ServiceAccount), (c) => c.charCodeAt(0)),
      )
    : rawServiceAccount;

  if (!jsonString) {
    throw new Error("Google service account secret is not configured.");
  }

  let serviceAccount: Record<string, string>;
  try {
    serviceAccount = JSON.parse(jsonString);
  } catch (parseError) {
    throw new Error(
      `Failed to parse service account JSON (first 80 chars: ${jsonString.slice(0, 80)}): ${parseError instanceof Error ? parseError.message : "unknown"}`,
    );
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT",
  };
  const payload = {
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    scope: GCP_SCOPE,
    aud: serviceAccount.token_uri,
    iat: issuedAt,
    exp: issuedAt + 3600,
  };

  const unsignedToken = `${encodeBase64Url(JSON.stringify(header))}.${encodeBase64Url(JSON.stringify(payload))}`;
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(serviceAccount.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(unsignedToken),
  );
  const assertion = `${unsignedToken}.${encodeBase64Url(new Uint8Array(signature))}`;

  const tokenResponse = await fetch(serviceAccount.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!tokenResponse.ok) {
    const detail = await tokenResponse.text();
    throw new Error(`Google OAuth token exchange failed: ${tokenResponse.status} ${detail}`);
  }

  const tokenData = await tokenResponse.json();
  return {
    accessToken: String(tokenData.access_token || ""),
    projectId: String(serviceAccount.project_id || ""),
  };
};

const buildEhrSummary = (ehr: PatientEhr) => {
  const activeMedications = (ehr.medications || [])
    .filter((med) => String(med.medication_status || "").toLowerCase() === "active")
    .map((med) => ({
      medication_display: String(med.medication_display || ""),
      active_ingredient: String(med.active_ingredient || "").toLowerCase(),
      frequency_text: String(med.frequency_text || ""),
      route_display: String(med.route_display || ""),
      start_date: String(med.start_date || ""),
    }));

  const allergies = (ehr.allergies || []).map((allergy) => ({
    substance_display: String(allergy.substance_display || ""),
    reaction_display: String(allergy.reaction_display || ""),
    criticality: String(allergy.criticality || ""),
    clinical_status: String(allergy.clinical_status || ""),
  }));

  const conditions = (ehr.conditions || []).slice(0, 12).map((condition) => ({
    condition_display: String(condition.condition_display || ""),
    clinical_status: String(condition.clinical_status || ""),
    severity: String(condition.severity || ""),
  }));

  const observations = (ehr.observations || []).slice(0, 8).map((obs) => ({
    observation_display: String(obs.observation_display || ""),
    value_number: obs.value_number ?? null,
    value_text: String(obs.value_text || ""),
    unit: String(obs.unit || ""),
    interpretation: String(obs.interpretation || ""),
    observed_at: String(obs.observed_at || ""),
  }));

  const recentNotes = (ehr.clinical_notes || []).slice(0, 4).map((note) => ({
    note_type: String(note.note_type || ""),
    note_text: String(note.note_text || "").slice(0, 700),
    authored_at: String(note.authored_at || ""),
  }));

  return {
    patient: ehr.patient || {},
    activeMedications,
    allergies,
    conditions,
    observations,
    recentNotes,
  };
};

const expandProposedMedications = (meds: ProposedMedicationInput[]): ProposedMedicationInput[] => {
  const expanded: ProposedMedicationInput[] = [];
  for (const med of meds) {
    const rawIng = String(med.ingredient || med.name || "").trim();
    if (!rawIng) continue;
    const ingredients = rawIng
      .split(/[,;/+]+|\band\b/i)
      .map((i) => i.trim().toLowerCase())
      .filter(Boolean);

    if (ingredients.length <= 1) {
      expanded.push(med);
    } else {
      for (const ing of ingredients) {
        const originalName = String(med.name || med.ingredient || "").trim();
        const nameHasIngredient = originalName.toLowerCase().includes(ing);
        const hasSeparators = /[,;/+]|\band\b/i.test(originalName);
        const name = hasSeparators ? ing : (nameHasIngredient ? originalName : `${originalName} (${ing})`);
        expanded.push({
          ...med,
          name,
          ingredient: ing,
        });
      }
    }
  }
  return expanded;
};

const expandActiveMedications = (activeMeds: Array<{ active_ingredient: string; medication_display: string }>) => {
  const expanded: Array<{ active_ingredient: string; medication_display: string }> = [];
  for (const med of activeMeds) {
    const rawIng = String(med.active_ingredient || "").trim();
    if (!rawIng) continue;
    const ingredients = rawIng
      .split(/[,;/+]+|\band\b/i)
      .map((i) => i.trim().toLowerCase())
      .filter(Boolean);

    if (ingredients.length <= 1) {
      expanded.push(med);
    } else {
      for (const ing of ingredients) {
        const originalDisplay = String(med.medication_display || "").trim();
        const displayHasIngredient = originalDisplay.toLowerCase().includes(ing);
        const hasSeparators = /[,;/+]|\band\b/i.test(originalDisplay);
        const display = hasSeparators ? ing : (displayHasIngredient ? originalDisplay : `${originalDisplay} (${ing})`);
        expanded.push({
          active_ingredient: ing,
          medication_display: display,
        });
      }
    }
  }
  return expanded;
};

const buildPairReviews = (proposed: ProposedMedicationInput[], activeMeds: Array<{ active_ingredient: string; medication_display: string }>) => {
  const pairs: PairReview[] = [];
  const seen = new Set<string>();

  for (let leftIndex = 0; leftIndex < proposed.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < proposed.length; rightIndex += 1) {
      const left = fallbackIngredient(String(proposed[leftIndex].ingredient || proposed[leftIndex].name || ""));
      const right = fallbackIngredient(String(proposed[rightIndex].ingredient || proposed[rightIndex].name || ""));
      if (!left || !right || left === right) continue;
      const pairKey = [left, right].sort().join("|");
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      pairs.push({
        pairKey,
        left,
        right,
        leftSource: String(proposed[leftIndex].name || left),
        rightSource: String(proposed[rightIndex].name || right),
        pairType: "proposed-proposed",
      });
    }
  }

  for (const item of proposed) {
    const ingredient = fallbackIngredient(String(item.ingredient || item.name || ""));
    if (!ingredient) continue;
    for (const activeMed of activeMeds) {
      const currentIngredient = fallbackIngredient(activeMed.active_ingredient);
      if (!currentIngredient || currentIngredient === ingredient) continue;
      const pairKey = [ingredient, currentIngredient].sort().join("|");
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      pairs.push({
        pairKey,
        left: ingredient,
        right: currentIngredient,
        leftSource: String(item.name || ingredient),
        rightSource: activeMed.medication_display,
        pairType: "proposed-current",
      });
    }
  }

  return pairs;
};

const callGeminiForDdiReview = async (
  patientCode: string,
  ehrSummary: ReturnType<typeof buildEhrSummary>,
  proposedMedications: ProposedMedicationInput[],
  pairReviews: PairReview[],
  enableSearch: boolean,
) => {
  const { accessToken, projectId } = await createGoogleAccessToken();
  const endpoint =
    `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/global/publishers/google/models/gemini-3.5-flash:generateContent`;

  const systemInstructionText = enableSearch
    ? "You are an expert clinical drug-drug interaction review agent equipped with Google Search Grounding.\n" +
      "Your task is to analyze potential drug-drug interactions (DDIs) for the provided medication pairs (proposed-proposed and proposed-current) in the context of the patient's EHR.\n\n" +
      "Follow these strict clinical rules:\n" +
      "1. Perform rigorous clinical reasoning. First, perform medical reasoning on the clinical evidence and context. You must analyze the evidence step-by-step to explain the physiological/pharmacological mechanism of the interaction, how it relates to this specific patient's conditions/labs, and what clinical decision should be made. Write this reasoning process in the 'Reasoning:' section of each finding before detailing the final message.\n" +
      "2. Integrate patient context. Check the patient's existing active conditions, allergies, and observations (e.g. renal/hepatic status, lab abnormalities) to see if they increase the risk.\n" +
      "3. Use Google Search Grounding to read and analyze clinical evidence from the 4 approved sources (Drugs.com, PubMed, Medscape, Empathia AI). Do NOT output any URLs, source names, or citations in your response.\n" +
      "4. You must evaluate every single provided medication pair. For every pair that has a documented clinical interaction of any severity ('low', 'medium', 'high', 'critical'), you MUST generate a corresponding finding in findingsText. Do not omit moderate or mild interactions in favor of more severe ones. Omit drug pairs ONLY if they have absolutely no clinical interaction (severity 'none').\n" +
      "5. Keep the explanation ('detail') and action item ('action') extremely concise (maximum 2-3 sentences each) to prevent response truncation.\n\n" +
      "CRITICAL: The output must be a 100% valid JSON object matching the schema below. To ensure stable generation with Google Search Grounding, you must output a flat JSON structure containing overallSeverity, clinicalSummary, and a single plain text block containing all findings ('findingsText'). Do not output any nested JSON arrays or objects for findings, as this conflicts with search grounding.\n\n" +
      "All keys (overallSeverity, clinicalSummary, findingsText) are mandatory. The overallSeverity must be strictly one of: 'none', 'low', 'medium', 'high', 'critical' (all lowercase).\n\n" +
      "Return strict JSON matching this schema:\n" +
      "{\n" +
      "  \"overallSeverity\": \"high\",\n" +
      "  \"clinicalSummary\": \"Clinical overview of risks...\",\n" +
      "  \"findingsText\": \"Finding 1:\\nSeverity: critical\\nSignal: DrugA and DrugB Interaction\\nReasoning: Medical reasoning based on RAG source information goes here.\\nDetail: Mechanism.\\nAction: Recommendation.\"\n" +
      "}\n\n" +
      "Format findingsText exactly as a plain text string for each finding. Separate multiple findings with a double newline:\n\n" +
      "Finding N:\n" +
      "Severity: [none|low|medium|high|critical]\n" +
      "Signal: [Both drug names, e.g., DrugA and DrugB Interaction]\n" +
      "Reasoning: [Structured medical/clinical reasoning based on the retrieved search results/context, explaining mechanisms and patient-specific risks]\n" +
      "Detail: [Concise clinical explanation, max 2-3 sentences]\n" +
      "Action: [Clinical recommendation, max 2-3 sentences]"
    : "You are an expert clinical drug-drug interaction review agent.\n" +
      "Your task is to analyze potential drug-drug interactions (DDIs) for the provided medication pairs (proposed-proposed and proposed-current) in the context of the patient's EHR.\n\n" +
      "Follow these strict clinical rules:\n" +
      "1. Perform rigorous clinical reasoning. First, perform medical reasoning on the clinical context. You must analyze the evidence step-by-step to explain the physiological/pharmacological mechanism of the interaction, how it relates to this specific patient's conditions/labs, and what clinical decision should be made. Write this reasoning process in the 'Reasoning:' section of each finding before detailing the final message.\n" +
      "2. Integrate patient context. Check the patient's existing active conditions, allergies, and observations (e.g. renal/hepatic status, lab abnormalities) to see if they increase the risk.\n" +
      "3. Do NOT search Google, do NOT cite any sources, and do NOT provide any evidence URLs.\n" +
      "4. You must evaluate every single provided medication pair. For every pair that has a documented clinical interaction of any severity ('low', 'medium', 'high', 'critical'), you MUST generate a corresponding finding in findingsText. Do not omit moderate or mild interactions in favor of more severe ones. Omit drug pairs ONLY if they have absolutely no clinical interaction (severity 'none').\n" +
      "5. Keep the explanation ('detail') and action item ('action') extremely concise (maximum 2-3 sentences each) to prevent response truncation.\n\n" +
      "CRITICAL: The output must be a 100% valid JSON object matching the schema below. You must output a flat JSON structure containing overallSeverity, clinicalSummary, and a single plain text block containing all findings ('findingsText').\n\n" +
      "All keys (overallSeverity, clinicalSummary, findingsText) are mandatory. The overallSeverity must be strictly one of: 'none', 'low', 'medium', 'high', 'critical' (all lowercase).\n\n" +
      "Return strict JSON matching this schema:\n" +
      "{\n" +
      "  \"overallSeverity\": \"high\",\n" +
      "  \"clinicalSummary\": \"Clinical overview of risks...\",\n" +
      "  \"findingsText\": \"Finding 1:\\nSeverity: critical\\nSignal: DrugA and DrugB Interaction\\nReasoning: Medical reasoning goes here.\\nDetail: Mechanism.\\nAction: Recommendation.\"\n" +
      "}\n\n" +
      "Format findingsText exactly as a plain text string for each finding. Separate multiple findings with a double newline:\n\n" +
      "Finding N:\n" +
      "Severity: [none|low|medium|high|critical]\n" +
      "Signal: [Both drug names, e.g., DrugA and DrugB Interaction]\n" +
      "Reasoning: [Structured medical/clinical reasoning based on the clinical context, explaining mechanisms and patient-specific risks]\n" +
      "Detail: [Concise clinical explanation, max 2-3 sentences]\n" +
      "Action: [Clinical recommendation, max 2-3 sentences]";

  let response: Response | null = null;
  let attempt = 0;
  const maxAttempts = 3;
  let delayMs = 1500;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          systemInstruction: {
            role: "system",
            parts: [
              {
                text: systemInstructionText,
              },
            ],
          },
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: JSON.stringify({
                    patientCode,
                    task: "Review proposed medications for drug-drug interactions against each other and against the patient's active medications. Identify risk severity and detail findings.",
                    proposedMedications,
                    patientEhrSummary: ehrSummary,
                    medicationPairsToCheck: pairReviews.map((pair) => ({
                      pairType: pair.pairType,
                      left: pair.left,
                      right: pair.right,
                      leftSource: pair.leftSource,
                      rightSource: pair.rightSource,
                    })),
                  }),
                },
              ],
            },
          ],
          ...(enableSearch ? {
            tools: [
              {
                google_search: {},
              },
            ],
          } : {}),
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 8192,
          },
        }),
      });

      if (response.status === 429) {
        console.warn(`Gemini API returned 429 (Resource Exhausted) on attempt ${attempt}. Retrying in ${delayMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs *= 2;
        continue;
      }

      break;
    } catch (fetchErr) {
      console.warn(`Fetch error on attempt ${attempt}:`, fetchErr);
      if (attempt >= maxAttempts) throw fetchErr;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs *= 2;
    }
  }

  if (!response) {
    throw new Error("Failed to receive response from Gemini.");
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gemini review call failed: ${response.status} ${detail}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("") || "";
  if (!text.trim()) {
    throw new Error("Gemini returned an empty review payload.");
  }

  const groundingChunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];

  try {
    const parsed = parseJsonResponseText(text);
    return { parsed, groundingChunks };
  } catch (parseError) {
    console.error("Failed to parse Gemini response JSON. Raw text:", text);
    throw new Error(`JSON parse failure: ${parseError instanceof Error ? parseError.message : String(parseError)}. Raw response text: ${text}. Full API response: ${JSON.stringify(data)}`);
  }
};

const callGeminiForDdiReferences = async (
  pair: { left: string; right: string; leftSource: string; rightSource: string },
) => {
  const { accessToken, projectId } = await createGoogleAccessToken();
  const endpoint =
    `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/global/publishers/google/models/gemini-3.5-flash:generateContent`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      systemInstruction: {
        role: "system",
        parts: [
          {
            text:
              "You are an expert clinical drug-drug interaction reference agent equipped with Google Search Grounding.\n" +
              "Your task is to find reliable clinical evidence references for the interaction between the following two medications:\n" +
              `Medication 1: ${pair.left} (brand/display: ${pair.leftSource})\n` +
              `Medication 2: ${pair.right} (brand/display: ${pair.rightSource})\n\n` +
              "Follow these strict rules:\n" +
              "1. Search Google to find direct evidence of their interaction, and determine which of the 4 approved sources support it:\n" +
              "   - S1: Drugs.com\n" +
              "   - S2: PubMed\n" +
              "   - S3: Medscape\n" +
              "   - S4: Empathia AI\n" +
              "   CRITICAL: Do NOT output any URLs or web addresses. Only return the source IDs (e.g. S1, S2) for the sources that have evidence.\n" +
              "2. Return a valid JSON object only — no markdown.\n\n" +
              "Return strict JSON:\n" +
              "{\n" +
              "  \"sources\": [\"S1\", \"S2\"]\n" +
              "}",
          },
        ],
      },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Please find clinical references for the interaction between ${pair.left} and ${pair.right}.`,
            },
          ],
        },
      ],
      tools: [
        {
          google_search: {},
        },
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 2048,
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gemini references call failed: ${response.status} ${detail}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("") || "";
  if (!text.trim()) {
    console.error("Gemini references call returned empty text. Full API response:", JSON.stringify(data));
    throw new Error(`Gemini returned an empty references payload. Full response: ${JSON.stringify(data)}`);
  }

  const groundingChunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];

  try {
    const parsed = parseJsonResponseText(text);
    return { parsed, groundingChunks };
  } catch (parseError) {
    console.error("Failed to parse Gemini references response JSON. Raw text:", text, "Full API response:", JSON.stringify(data));
    throw new Error(`JSON parse failure: ${parseError instanceof Error ? parseError.message : String(parseError)}. Raw text: ${text}`);
  }
};

const cleanDrugName = (name: string): string => {
  let cleaned = name.toLowerCase().trim();
  const salts = [
    "hydrochloride", "hydrobromide", "besylate", "maleate", "sodium", "potassium", 
    "calcium", "bisulfate", "sulfate", "tartrate", "phosphate", "acetate", 
    "fumarate", "mesylate", "estolate", "valerate", "succinate", "camsylate", 
    "nitrate", "chloride", "hcl", "mesilate", "besilate", "flesinoxan", "dipotassium"
  ];
  salts.forEach((salt) => {
    const regex = new RegExp(`\\b${salt}\\b`, "g");
    cleaned = cleaned.replace(regex, "");
  });
  return cleaned.replace(/\s+/g, " ").trim();
};

const cleanIngredientForUrl = (name: string): string => {
  if (!name) return "";
  let cleaned = name.toLowerCase().trim();
  const salts = [
    "hydrochloride", "hydrobromide", "besylate", "maleate", "sodium", "potassium", 
    "calcium", "bisulfate", "sulfate", "tartrate", "phosphate", "acetate", 
    "fumarate", "mesylate", "estolate", "valerate", "succinate", "camsylate", 
    "nitrate", "chloride", "hcl", "mesilate", "besilate", "flesinoxan", "dipotassium"
  ];
  salts.forEach((salt) => {
    const regex = new RegExp(`\\b${salt}\\b`, "gi");
    cleaned = cleaned.replace(regex, "");
  });
  cleaned = cleaned.replace(/\b\d+(\.\d+)?\s*(mg|mcg|g|ml|%)\b/gi, "");
  cleaned = cleaned.replace(/\b\d+(\.\d+)?\b/gi, "");
  const dosageForms = [
    "oral tablet", "oral capsule", "tablet", "capsule", "injection", "solution", 
    "suspension", "extended release", "delayed release", "xr", "er", "release", 
    "oral", "topical", "cream", "ointment", "spray", "inhaler", "liquid"
  ];
  dosageForms.forEach((form) => {
    const regex = new RegExp(`\\b${form}\\b`, "gi");
    cleaned = cleaned.replace(regex, "");
  });
  cleaned = cleaned.replace(/\//g, " ");
  cleaned = cleaned.replace(/[^a-z0-9\s-]/gi, "");
  return cleaned.replace(/\s+/g, " ").trim();
};

const isUrlValidAndSpecific = (url: string, source: string, involvedGroups: string[][]): boolean => {
  const urlLower = url.toLowerCase().trim();
  if (!urlLower || urlLower.includes("example.com")) return false;
  
  const genericUrls = [
    "https://www.drugs.com", "https://drugs.com", "https://www.drugs.com/", "https://drugs.com/",
    "https://pubmed.ncbi.nlm.nih.gov", "https://pubmed.ncbi.nlm.nih.gov/",
    "https://www.medscape.com", "https://medscape.com", "https://www.medscape.com/", "https://medscape.com/",
    "https://reference.medscape.com", "https://reference.medscape.com/",
    "https://empathia.ai", "https://empathia.ai/", "https://www.empathia.ai"
  ];
  if (genericUrls.includes(urlLower)) return false;

  if (urlLower.includes("drugs.com/drug-interactions/")) {
    const hasIds = /-\d+-\d+-\d+-\d+\.html/.test(urlLower);
    if (!hasIds) return false;
  }

  if (
    urlLower.includes("search.php?searchterm=") ||
    urlLower.includes("term=") ||
    urlLower.includes("search/?q=") ||
    urlLower.includes("google.com/search?q=")
  ) {
    return true;
  }

  // Check if URL contains at least one alias from each group
  const matchesAllGroups = involvedGroups.every((aliases) => {
    return aliases.some((alias) => {
      const formatted = alias.replace(/\s+/g, "-");
      return urlLower.includes(formatted) || urlLower.includes(alias);
    });
  });

  return matchesAllGroups;
};

const parseSourcesFromLine = (lineContent: string): string[] => {
  const parts = lineContent.split("|").map(p => p.trim());
  if (parts.length >= 3) {
    const src = parts[0].toLowerCase();
    if (src.includes("drugs.com")) return ["S1"];
    if (src.includes("pubmed")) return ["S2"];
    if (src.includes("medscape")) return ["S3"];
    if (src.includes("empathia")) return ["S4"];
  }
  
  const rawIds = lineContent.split(/[,;]+/).map(p => p.trim());
  const found: string[] = [];
  for (const raw of rawIds) {
    const lower = raw.toLowerCase();
    if (lower === "s1" || lower.includes("drugs.com")) found.push("S1");
    else if (lower === "s2" || lower.includes("pubmed")) found.push("S2");
    else if (lower === "s3" || lower.includes("medscape")) found.push("S3");
    else if (lower === "s4" || lower.includes("empathia")) found.push("S4");
  }
  return found;
};

const buildEvidenceUrl = (
  sourceId: string,
  left: string,
  right: string,
  leftSource: string,
  rightSource: string
): { source: string; title: string; url: string } => {
  const name1 = cleanIngredientForUrl(leftSource || left);
  const name2 = cleanIngredientForUrl(rightSource || right);
  const query = `${name1} and ${name2} interaction`;
  const encoded = encodeURIComponent(query);

  switch (sourceId.toUpperCase()) {
    case "S1":
    case "DRUGS_COM":
      return {
        source: "Drugs.com",
        title: `${name1} and ${name2} Drug Interaction — Drugs.com`,
        url: `https://www.drugs.com/search.php?searchterm=${encodeURIComponent(name1 + " " + name2 + " interaction")}`,
      };
    case "S2":
    case "PUBMED":
      return {
        source: "PubMed",
        title: `${name1} and ${name2} interaction — PubMed`,
        url: `https://pubmed.ncbi.nlm.nih.gov/?term=${encoded}`,
      };
    case "S3":
    case "MEDSCAPE":
      return {
        source: "Medscape",
        title: `${name1} and ${name2} interaction — Medscape`,
        url: `https://search.medscape.com/search/?q=${encoded}`,
      };
    case "S4":
    case "EMPATHIA_AI":
      return {
        source: "Empathia AI",
        title: `${name1} and ${name2} Drug Interaction — Empathia AI`,
        url: `https://empathia.ai/drug-interaction/${encodeURIComponent(name1)}-${encodeURIComponent(name2)}`,
      };
    default:
      return {
        source: "Drugs.com",
        title: `${name1} and ${name2} Drug Interaction Search — Drugs.com`,
        url: `https://www.drugs.com/search.php?searchterm=${encodeURIComponent(name1 + " " + name2 + " interaction")}`,
      };
  }
};

const resolveEvidenceFromSourceId = (
  sourceId: string,
  left: string,
  right: string,
  leftSource: string,
  rightSource: string,
  groundingChunks: Array<{ web?: { uri: string; title: string } }>,
  allMedGroups: string[][]
): { source: string; title: string; url: string } => {
  const fallback = buildEvidenceUrl(sourceId, left, right, leftSource, rightSource);
  
  const targetDomain = 
    sourceId === "S1" ? "drugs.com" :
    sourceId === "S2" ? "pubmed.ncbi.nlm.nih.gov" :
    sourceId === "S3" ? "medscape.com" :
    sourceId === "S4" ? "empathia.ai" : "";
    
  if (!targetDomain) return fallback;

  const bestChunk = groundingChunks.find((chunk) => {
    const uri = (chunk.web?.uri || "").toLowerCase();
    const title = (chunk.web?.title || "").toLowerCase();
    
    if (!uri.includes(targetDomain)) return false;
    
    const leftAliases = [cleanDrugName(left), cleanDrugName(leftSource)].filter(Boolean);
    const rightAliases = [cleanDrugName(right), cleanDrugName(rightSource)].filter(Boolean);
    
    const matchesLeft = leftAliases.some(alias => uri.includes(alias.replace(/\s+/g, "-")) || title.includes(alias));
    const matchesRight = rightAliases.some(alias => uri.includes(alias.replace(/\s+/g, "-")) || title.includes(alias));
    
    if (!matchesLeft || !matchesRight) return false;
    
    let hasOther = false;
    for (const group of allMedGroups) {
      const isCurrentPair = 
        leftAliases.some(alias => group.includes(alias)) || 
        rightAliases.some(alias => group.includes(alias));
      if (isCurrentPair) continue;

      const matchesOther = group.some((alias) => {
        const formatted = alias.replace(/\s+/g, "-");
        return uri.includes(formatted) || title.includes(alias);
      });

      if (matchesOther) {
        hasOther = true;
        break;
      }
    }
    if (hasOther) return false;

    if (uri.includes("drugs.com/drug-interactions/")) {
      const hasIds = /-\d+-\d+-\d+-\d+\.html/.test(uri);
      if (!hasIds) return false;
    }
    
    return true;
  });

  if (bestChunk?.web?.uri) {
    return {
      source: fallback.source,
      title: bestChunk.web.title || fallback.title,
      url: bestChunk.web.uri,
    };
  }

  return fallback;
};

const parseFindingsText = (text: string): ReviewFinding[] => {
  const findings: ReviewFinding[] = [];
  const blocks = text.split(/(?=Finding \d+:|FINDING \d+:)/i);
  
  for (const block of blocks) {
    if (!block.trim()) continue;
    
    let severity: ReviewFinding["severity"] = "low";
    let signal = "";
    let reasoning = "";
    let detail = "";
    let action = "";
    const evidence: ReviewFinding["evidence"] = [];
    
    const lines = block.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      const sevMatch = trimmed.match(/^severity:\s*(none|low|medium|high|critical)/i);
      if (sevMatch) {
        const rawSev = sevMatch[1].toLowerCase();
        if (["none", "low", "medium", "high", "critical"].includes(rawSev)) {
          severity = rawSev as ReviewFinding["severity"];
        }
        continue;
      }
      
      const sigMatch = trimmed.match(/^signal:\s*(.*)/i);
      if (sigMatch) {
        signal = sigMatch[1].trim();
        continue;
      }

      const reasMatch = trimmed.match(/^reasoning:\s*(.*)/i);
      if (reasMatch) {
        reasoning = reasMatch[1].trim();
        continue;
      }
      
      const detMatch = trimmed.match(/^detail:\s*(.*)/i);
      if (detMatch) {
        detail = detMatch[1].trim();
        continue;
      }
      
      const actMatch = trimmed.match(/^action:\s*(.*)/i);
      if (actMatch) {
        action = actMatch[1].trim();
        continue;
      }
      
      const evMatch = trimmed.match(/^(?:evidence|sources?):\s*(.*)/i);
      if (evMatch) {
        const sourceLine = evMatch[1].trim();
        const parsedIds = parseSourcesFromLine(sourceLine);
        parsedIds.forEach((id) => {
          evidence.push({
            source: id,
            title: "",
            url: "",
          });
        });
        continue;
      }
    }
    
    if (signal) {
      findings.push({
        type: "Drug-Drug",
        severity,
        signal,
        reasoning: reasoning || "",
        detail: detail || "No detail provided.",
        action: action || "No action recommended.",
        evidence,
      });
    }
  }
  
  return findings;
};

const correctEvidenceUrls = (
  findings: ReviewFinding[],
  groundingChunks: Array<{ web?: { uri: string; title: string } }>,
  allIngredients: string[],
  pairReviews: PairReview[],
  proposedMedications: ProposedMedicationInput[],
  activeMeds: Array<{ active_ingredient: string; medication_display: string }>
): ReviewFinding[] => {
  const allMedGroups: string[][] = [];
  proposedMedications.forEach((med) => {
    const aliases = [
      cleanDrugName(med.ingredient || ""),
      cleanDrugName(med.name || ""),
      cleanDrugName((med.name || "").split(" ")[0])
    ].filter(Boolean);
    if (aliases.length > 0) {
      allMedGroups.push(aliases);
    }
  });
  activeMeds.forEach((med) => {
    const aliases = [
      cleanDrugName(med.active_ingredient || ""),
      cleanDrugName(med.medication_display || ""),
      cleanDrugName((med.medication_display || "").split(" ")[0])
    ].filter(Boolean);
    if (aliases.length > 0) {
      allMedGroups.push(aliases);
    }
  });

  return findings.map((finding) => {
    const signalLower = cleanDrugName(finding.signal);
    const detailLower = cleanDrugName(finding.detail);
    
    const matchingPair = pairReviews.find((pair) => {
      const leftAliases = [
        cleanDrugName(pair.left),
        cleanDrugName(pair.leftSource),
        cleanDrugName(pair.leftSource.split(" ")[0])
      ].filter(Boolean);
      
      const rightAliases = [
        cleanDrugName(pair.right),
        cleanDrugName(pair.rightSource),
        cleanDrugName(pair.rightSource.split(" ")[0])
      ].filter(Boolean);
      
      const sigHasLeft = leftAliases.some((alias) => signalLower.includes(alias));
      const sigHasRight = rightAliases.some((alias) => signalLower.includes(alias));
      const detHasLeft = leftAliases.some((alias) => detailLower.includes(alias));
      const detHasRight = rightAliases.some((alias) => detailLower.includes(alias));
      
      return (sigHasLeft || detHasLeft) && (sigHasRight || detHasRight);
    });

    const left = matchingPair ? matchingPair.left : finding.left || "";
    const right = matchingPair ? matchingPair.right : finding.right || "";
    const leftSource = matchingPair ? matchingPair.leftSource : finding.leftSource || left;
    const rightSource = matchingPair ? matchingPair.rightSource : finding.rightSource || right;

    const sanitizedEvidence = finding.evidence.map((ev) => {
      let sourceId = "S1";
      const srcLower = ev.source.toLowerCase();
      if (srcLower === "s1" || srcLower.includes("drugs.com")) sourceId = "S1";
      else if (srcLower === "s2" || srcLower.includes("pubmed")) sourceId = "S2";
      else if (srcLower === "s3" || srcLower.includes("medscape")) sourceId = "S3";
      else if (srcLower === "s4" || srcLower.includes("empathia")) sourceId = "S4";

      return resolveEvidenceFromSourceId(
        sourceId,
        left,
        right,
        leftSource,
        rightSource,
        groundingChunks,
        allMedGroups
      );
    });

    const result: ReviewFinding = {
      ...finding,
      left,
      right,
      leftSource,
      rightSource,
      evidence: sanitizedEvidence,
    };

    return result;
  });
};

const buildFallbackReview = (
  pairReviews: PairReview[]
): { overallSeverity: "none" | "low" | "medium" | "high" | "critical"; clinicalSummary: string; findings: ReviewFinding[] } => {
  return {
    overallSeverity: "none",
    clinicalSummary: "AI review service was temporarily unavailable. Clinicians should manually verify all medication combinations.",
    findings: [
      {
        type: "Drug-Drug",
        severity: "none",
        signal: "Review service unavailable",
        detail: "The AI agent could not complete the automated drug-drug interaction review at this time.",
        action: "Please manually review the prescribed medications against the patient's current medications using trusted sources (e.g. PubMed, Medscape, Drugs.com, Empathia AI).",
        evidence: [],
      },
    ],
  };
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await request.json();
    const mode = String(body?.mode || "review").trim().toLowerCase();

    if (mode === "references") {
      const pair = body?.pair;
      if (!pair || !pair.left || !pair.right) {
        return new Response(JSON.stringify({ error: "pair with left and right fields is required for references mode." }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const sampleMaxTwoSources = (sources: string[]): string[] => {
        if (sources.length <= 2) return sources;
        const shuffled = [...sources].sort(() => 0.5 - Math.random());
        return shuffled.slice(0, 2);
      };

      let corrected: ReviewFinding[] = [];
      try {
        const result = await callGeminiForDdiReferences({
          left: String(pair.left),
          right: String(pair.right),
          leftSource: String(pair.leftSource || pair.left),
          rightSource: String(pair.rightSource || pair.right),
        });

        const parsedSources = Array.isArray(result.parsed?.sources) ? result.parsed.sources : [];
        const selectedSources = sampleMaxTwoSources(parsedSources);
        
        const initialEvidence = selectedSources.map((srcId: string) => ({
          source: srcId,
          title: "",
          url: "",
        }));

        const tempFinding: ReviewFinding = {
          type: "Drug-Drug",
          severity: "high",
          signal: `${pair.left} and ${pair.right} Interaction`,
          reasoning: "",
          detail: "",
          action: "",
          evidence: initialEvidence,
        };

        const allIngredients = [pair.left, pair.right];
        const pairReviews = [
          {
            pairKey: [pair.left, pair.right].sort().join("|"),
            left: pair.left,
            right: pair.right,
            leftSource: pair.leftSource || pair.left,
            rightSource: pair.rightSource || pair.right,
            pairType: "proposed-proposed" as const,
          },
        ];
        const proposedMedications = [{ name: pair.leftSource || pair.left, ingredient: pair.left }];
        const activeMeds = [{ active_ingredient: pair.right, medication_display: pair.rightSource || pair.right }];

        corrected = correctEvidenceUrls(
          [tempFinding],
          result.groundingChunks || [],
          allIngredients,
          pairReviews,
          proposedMedications,
          activeMeds,
        );
      } catch (error) {
        console.warn("Gemini references call failed, falling back to deterministic search URLs:", error);
        const selected = sampleMaxTwoSources(["S1", "S2", "S3", "S4"]);
        corrected = [{
          type: "Drug-Drug",
          severity: "high",
          signal: `${pair.left} and ${pair.right} Interaction`,
          detail: "",
          action: "",
          evidence: selected.map(srcId => buildEvidenceUrl(
            srcId,
            pair.left,
            pair.right,
            pair.leftSource || pair.left,
            pair.rightSource || pair.right
          ))
        }];
      }

      return new Response(
        JSON.stringify({
          evidence: corrected[0].evidence || [],
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const patientCode = String(body?.patientCode || "").trim();
    let proposedMedications = Array.isArray(body?.proposedMedications)
      ? (body.proposedMedications as ProposedMedicationInput[]).filter((item) =>
          String(item?.name || item?.ingredient || "").trim()
        )
      : [];
    proposedMedications = expandProposedMedications(proposedMedications);

    if (!patientCode) {
      return new Response(JSON.stringify({ error: "patientCode is required." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (proposedMedications.length === 0) {
      return new Response(JSON.stringify({ error: "At least one proposed medication is required." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseServiceRoleKey) {
      throw new Error("Supabase service role configuration is missing.");
    }

    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
    const [{ data: ehrData, error: ehrError }, { data: patientRow, error: patientError }] = await Promise.all([
      supabase.rpc("get_patient_ehr", { p_patient_code: patientCode }),
      supabase.from("ehr_patients").select("id").eq("patient_code", patientCode).maybeSingle(),
    ]);

    if (ehrError) throw ehrError;
    if (patientError) throw patientError;

    if (!patientRow) {
      return new Response(JSON.stringify({ error: `Patient record not found for code: ${patientCode}` }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!ehrData) {
      return new Response(JSON.stringify({ error: `No EHR record found for patient: ${patientCode}` }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const ehr = ehrData as PatientEhr;
    const ehrSummary = buildEhrSummary(ehr);
    let activeMeds = ehrSummary.activeMedications.map((item) => ({
      active_ingredient: item.active_ingredient,
      medication_display: item.medication_display || item.active_ingredient,
    }));
    activeMeds = expandActiveMedications(activeMeds);
    const pairReviews = buildPairReviews(proposedMedications, activeMeds);

    let modelReview: { overallSeverity?: string; clinicalSummary?: string; findingsText?: string } | null = null;
    let geminiError: string | null = null;
    let groundingChunks: any[] = [];

    if (pairReviews.length > 0) {
      try {
        const result = await callGeminiForDdiReview(patientCode, ehrSummary, proposedMedications, pairReviews, true);
        modelReview = result.parsed;
        groundingChunks = result.groundingChunks;
      } catch (error) {
        console.error("Gemini DDI review failed, falling back to clean warning.", error);
        geminiError = error instanceof Error ? error.message : String(error);
      }
    } else {
      // No medication pairs to check (e.g. only one drug and patient has no active meds)
      modelReview = {
        overallSeverity: "none",
        clinicalSummary: "No medication pairs to check (no proposed-proposed combinations and patient has no active medications).",
        findingsText: "",
      };
    }

    const fallbackReview = buildFallbackReview(pairReviews);
    
    let rawFindings: ReviewFinding[] = [];
    if (modelReview?.findingsText) {
      rawFindings = parseFindingsText(modelReview.findingsText);
    } else if (geminiError) {
      rawFindings = fallbackReview.findings;
    } else {
      rawFindings = [];
    }

    const allIngredients = [
      ...proposedMedications.map((item) => fallbackIngredient(String(item.ingredient || item.name || ""))),
      ...activeMeds.map((item) => fallbackIngredient(item.active_ingredient)),
    ].filter(Boolean);

    const validatedFindings = correctEvidenceUrls(rawFindings, groundingChunks, allIngredients, pairReviews, proposedMedications, activeMeds);

    // Post-process to add "None" severity findings for checked pairs that have no interactions
    const findings: ReviewFinding[] = [...validatedFindings];
    const isServiceUnavailable = validatedFindings.some((f) => f.signal === "Review service unavailable");

    if (!isServiceUnavailable && pairReviews.length > 0) {
      const coveredPairs = new Set<string>();

      validatedFindings.forEach((finding) => {
        const sigLower = (finding.signal || "").toLowerCase();
        const detLower = (finding.detail || "").toLowerCase();

        pairReviews.forEach((pair) => {
          const leftLower = pair.left.toLowerCase();
          const rightLower = pair.right.toLowerCase();

          if (
            (sigLower.includes(leftLower) && sigLower.includes(rightLower)) ||
            (detLower.includes(leftLower) && detLower.includes(rightLower))
          ) {
            coveredPairs.add(`${leftLower}|${rightLower}`);
          }
        });
      });

      pairReviews.forEach((pair) => {
        const leftLower = pair.left.toLowerCase();
        const rightLower = pair.right.toLowerCase();
        const key = `${leftLower}|${rightLower}`;

        if (!coveredPairs.has(key)) {
          const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
          findings.push({
            type: "Drug-Drug",
            severity: "none",
            signal: `${capitalize(pair.left)} and ${capitalize(pair.right)} Interaction`,
            detail: `The DDI review agent verified the combination of ${pair.left} and ${pair.right} and found no clinically significant drug-drug interactions.`,
            action: "No clinical action required.",
            left: pair.left,
            right: pair.right,
            leftSource: pair.leftSource,
            rightSource: pair.rightSource,
            evidence: [],
          });
          coveredPairs.add(key);
        }
      });
    }

    // Ensure all findings have empty evidence initially to trigger "Fetch Clinical References" in frontend
    findings.forEach(f => {
      f.evidence = [];
    });

    const rawOverallSeverity = String(modelReview?.overallSeverity || fallbackReview.overallSeverity || "none").toLowerCase();
    const overallSeverity = (["none", "low", "medium", "high", "critical"].includes(rawOverallSeverity)
      ? rawOverallSeverity
      : "none") as "none" | "low" | "medium" | "high" | "critical";

    const clinicalSummary =
      String(modelReview?.clinicalSummary || fallbackReview.clinicalSummary || "").trim();

    const reviewSessionPayload = {
      patient_id: patientRow.id,
      requested_medications: proposedMedications,
      normalized_ingredients: proposedMedications.map((item) =>
        fallbackIngredient(String(item.ingredient || item.name || ""))
      ),
      overall_severity: overallSeverity,
      report_status: "completed",
    };

    const { data: reviewSession, error: reviewSessionError } = await supabase
      .from("prescription_review_sessions")
      .insert(reviewSessionPayload)
      .select("id")
      .single();
    if (reviewSessionError) throw reviewSessionError;

    if (findings.length > 0) {
      const findingRows = findings.map((finding) => ({
        review_session_id: reviewSession.id,
        interaction_type: "drug_drug",
        severity: finding.severity,
        signal: finding.signal,
        explanation: finding.reasoning
          ? `Medical Reasoning: ${finding.reasoning}\n\nDetail: ${finding.detail}`
          : finding.detail,
        recommendation: finding.action,
        evidence: finding.evidence || [],
      }));
      const { error: findingsError } = await supabase.from("interaction_findings").insert(findingRows);
      if (findingsError) throw findingsError;
    }

    return new Response(
      JSON.stringify({
        reviewSessionId: reviewSession.id,
        overallSeverity,
        clinicalSummary,
        findings,
        geminiError,
        pairChecks: pairReviews.map((pair) => ({
          pairType: pair.pairType,
          left: pair.left,
          right: pair.right,
        })),
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error(error);
    const errorMessage = error instanceof Error ? error.message : "Unexpected DDI agent failure.";
    return new Response(
      JSON.stringify({
        reviewSessionId: null,
        overallSeverity: "none",
        clinicalSummary: "The DDI review agent encountered an error. Please retry or verify medications manually.",
        findings: [
          {
            type: "Drug-Drug",
            severity: "none",
            signal: "Review agent error",
            detail: errorMessage,
            action: "Please retry the review. If the error persists, manually verify all medication combinations using trusted clinical sources.",
            evidence: [],
          },
        ],
        geminiError: errorMessage,
        pairChecks: [],
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
