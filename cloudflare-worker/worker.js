// Бесплатный прокси для Cloudflare Workers (работает без VPN из любой страны).
// В настройках воркера (Settings -> Variables and Secrets) добавьте секрет GEMINI_API_KEY,
// тогда сам ключ даже не придётся хранить внутри телефона.
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, x-goog-api-key',
        },
      });
    }

    const url = new URL(request.url);
    const targetUrl = `https://generativelanguage.googleapis.com${url.pathname}${url.search}`;

    const headers = new Headers(request.headers);
    headers.delete('host');
    if (env.GEMINI_API_KEY) {
      headers.set('x-goog-api-key', env.GEMINI_API_KEY);
    }

    const upstream = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    });

    const respHeaders = new Headers(upstream.headers);
    respHeaders.set('Access-Control-Allow-Origin', '*');

    return new Response(upstream.body, {
      status: upstream.status,
      headers: respHeaders,
    });
  },
};
