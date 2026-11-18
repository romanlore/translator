const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const REQUEST_TIMEOUT_MS = 20000;

function buildEndpoint(baseUrl, model) {
  const cleanBase = (baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  return `${cleanBase}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

function parseJsonResponse(rawText) {
  if (!rawText) return null;
  try {
    return JSON.parse(rawText);
  } catch {
    const match = rawText.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Сервер не ответил за 20 сек. Проверьте интернет, прокси или VPN.');
    }
    throw new Error('Нет соединения с сервером. Проверьте интернет, прокси или VPN.');
  } finally {
    clearTimeout(timer);
  }
}

export async function transcribeAndTranslateAudio({
  base64Audio,
  mimeType = 'audio/mp4',
  direction,
  apiKey,
  baseUrl,
  model = 'gemini-3.8-flash',
  includeTranslit = true,
}) {
  const isRuToHi = direction === 'ru-hi';
  const prompt = isRuToHi
    ? `Распознай русскую речь на аудиозаписи и переведи её на естественный разговорный хинди (письмо деванагари).${
        includeTranslit ? ' Также добавь простую транслитерацию хинди латиницей.' : ''
      } Верни строго JSON без markdown: {"transcript": "распознанный русский текст", "translation": "перевод на хинди", "translit": "${
        includeTranslit ? 'транслитерация латиницей' : ''
      }"}`
    : `Распознай речь на хинди (или хинглише) на аудиозаписи и переведи её на естественный разговорный русский язык. Верни строго JSON без markdown: {"transcript": "распознанный текст на хинди", "translation": "перевод на русский", "translit": ""}`;

  const url = buildEndpoint(baseUrl, model);
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-goog-api-key'] = apiKey;

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType,
                data: base64Audio,
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
      },
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || `Ошибка Gemini API (${response.status})`);
  }

  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const parsed = parseJsonResponse(rawText);

  if (!parsed || !parsed.translation) {
    throw new Error('Не удалось распознать речь. Попробуйте говорить чуть ближе к микрофону.');
  }

  return {
    transcript: (parsed.transcript || '').trim(),
    translation: (parsed.translation || '').trim(),
    translit: isRuToHi && includeTranslit ? (parsed.translit || '').trim() : '',
  };
}

export async function translateText({
  text,
  direction,
  apiKey,
  baseUrl,
  model = 'gemini-3.8-flash',
  includeTranslit = true,
}) {
  const isRuToHi = direction === 'ru-hi';
  const prompt = isRuToHi
    ? `Переведи фразу с русского на естественный разговорный хинди (деванагари).${
        includeTranslit ? ' Добавь транслитерацию латиницей.' : ''
      } Верни строго JSON без markdown: {"translation": "...", "translit": "..."}.\nФраза: ${text}`
    : `Переведи фразу с хинди на естественный разговорный русский язык. Верни строго JSON без markdown: {"translation": "...", "translit": ""}.\nФраза: ${text}`;

  const url = buildEndpoint(baseUrl, model);
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-goog-api-key'] = apiKey;

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
      },
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || `Ошибка Gemini API (${response.status})`);
  }

  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const parsed = parseJsonResponse(rawText);

  return {
    transcript: text,
    translation: (parsed?.translation || rawText || '').trim(),
    translit: isRuToHi && includeTranslit ? (parsed?.translit || '').trim() : '',
  };
}
