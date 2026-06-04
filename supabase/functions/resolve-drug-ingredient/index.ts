const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Resolution = {
  ingredient: string;
  ingredients: string[];
  status: "resolved" | "ingredient" | "unconfirmed" | "failed";
  source: string;
  note: string;
};

/* ------------------------------------------------------------------ */
/*  GCP service-account auth (same pattern used by review-ddi)        */
/* ------------------------------------------------------------------ */

const GCP_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

const encodeBase64Url = (value: string | Uint8Array) => {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
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
  const header = { alg: "RS256", typ: "JWT" };
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
    throw new Error(
      `Google OAuth token exchange failed: ${tokenResponse.status} ${detail}`,
    );
  }

  const tokenData = await tokenResponse.json();
  return {
    accessToken: String(tokenData.access_token || ""),
    projectId: String(serviceAccount.project_id || ""),
  };
};

/* ------------------------------------------------------------------ */
/*  Call Gemini 3.5 Flash to resolve a drug name                      */
/* ------------------------------------------------------------------ */

const resolveWithGemini = async (
  drugName: string,
): Promise<Resolution> => {
  const { accessToken, projectId } = await createGoogleAccessToken();
  const endpoint = `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/global/publishers/google/models/gemini-3.5-flash:generateContent`;

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
            text: `You are a pharmaceutical drug name resolver. Your job is to identify the active pharmaceutical ingredient (INN/generic name) for any drug input.

Rules:
1. If the input is a BRAND NAME (e.g. "Augmentin", "Lipitor", "Clodorel"), return the active ingredient(s) (e.g. "amoxicillin, clavulanic acid", "atorvastatin", "clopidogrel").
2. If the input is ALREADY an active ingredient / INN / generic name (e.g. "metformin", "clopidogrel"), confirm it as the active ingredient.
3. If the input is MISSPELLED (e.g. "clopidorel", "amoxicilin", "ibuprofn", "paracetmol"), correct the spelling and return the correct active ingredient.
4. If the input is a combination product, return all active ingredients separated by commas.
5. If you truly cannot identify the drug at all, set resolved to false.
6. Always return ingredient names in lowercase.
7. For the inputType field: use "brand_name" if the original input was a brand/trade name, "active_ingredient" if it was already a generic/INN name, "misspelled" if it contained a spelling error, or "unknown" if you cannot identify it.
8. For the correctedInput field: if the input was misspelled, provide the corrected spelling. If it was a brand name, provide the brand name. Otherwise leave it the same as the input.

Return strict JSON with these keys: resolved (boolean), ingredient (string - the active ingredient(s) in lowercase), ingredients (array of strings - each individual active ingredient in lowercase), inputType (string - one of "brand_name", "active_ingredient", "misspelled", "unknown"), correctedInput (string), explanation (string - brief explanation of the resolution).`,
          },
        ],
      },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Resolve this drug name to its active pharmaceutical ingredient: "${drugName}"`,
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
        temperature: 0.05,
        maxOutputTokens: 2048,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            resolved: { type: "BOOLEAN" },
            ingredient: { type: "STRING" },
            ingredients: {
              type: "ARRAY",
              items: { type: "STRING" },
            },
            inputType: { type: "STRING" },
            correctedInput: { type: "STRING" },
            explanation: { type: "STRING" },
          },
          required: [
            "resolved",
            "ingredient",
            "ingredients",
            "inputType",
            "correctedInput",
            "explanation",
          ],
        },
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gemini call failed: ${response.status} ${detail}`);
  }

  const data = await response.json();
  console.log("Gemini response data:", JSON.stringify(data));
  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map((part: { text?: string }) => part.text || "")
      .join("") || "";

  if (!text.trim()) {
    throw new Error(`Gemini returned an empty response. Raw data: ${JSON.stringify(data)}`);
  }

  const parsed = JSON.parse(text.trim());

  if (!parsed.resolved || !parsed.ingredient) {
    return {
      ingredient: "",
      ingredients: [],
      status: "unconfirmed",
      source: "Gemini 3.5 Flash",
      note: parsed.explanation ||
        `Could not resolve "${drugName}" to a known active ingredient.`,
    };
  }

  const ingredients: string[] = Array.isArray(parsed.ingredients)
    ? parsed.ingredients.map((i: string) => i.trim().toLowerCase()).filter(Boolean)
    : [parsed.ingredient.trim().toLowerCase()];

  const ingredientDisplay = parsed.ingredient.trim().toLowerCase();
  const inputType: string = parsed.inputType || "unknown";
  const correctedInput: string = parsed.correctedInput || drugName;

  let status: Resolution["status"];
  let note: string;

  if (inputType === "active_ingredient") {
    status = "ingredient";
    note = `"${drugName}" is already a known active ingredient.`;
  } else if (inputType === "misspelled") {
    status = "resolved";
    note = `Corrected "${drugName}" to "${correctedInput}". Active ingredient: ${ingredientDisplay}.`;
  } else if (inputType === "brand_name") {
    status = "resolved";
    note = `Resolved brand name "${drugName}" to active ingredient: ${ingredientDisplay}.`;
  } else {
    status = "resolved";
    note = parsed.explanation ||
      `Resolved "${drugName}" to ${ingredientDisplay}.`;
  }

  return {
    ingredient: ingredientDisplay,
    ingredients,
    status,
    source: "Gemini 3.5 Flash",
    note,
  };
};

/* ------------------------------------------------------------------ */
/*  Deno HTTP handler                                                  */
/* ------------------------------------------------------------------ */

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { drugName } = await request.json();
    const normalized = String(drugName || "").trim();

    if (!normalized) {
      return Response.json(
        {
          ingredient: "",
          ingredients: [],
          status: "failed",
          source: "",
          note: "No drug name supplied.",
        } satisfies Resolution,
        { headers: corsHeaders, status: 400 },
      );
    }

    const result = await resolveWithGemini(normalized);
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    console.error("resolve-drug-ingredient error:", error);
    return Response.json(
      {
        ingredient: "",
        ingredients: [],
        status: "failed",
        source: "Gemini 3.5 Flash",
        note: error instanceof Error
          ? error.message
          : "Drug ingredient resolver failed.",
      } satisfies Resolution,
      { headers: corsHeaders },
    );
  }
});
