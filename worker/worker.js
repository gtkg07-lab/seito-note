// 生徒進捗ノート：写真の読み取りの中継（Cloudflare Workers）
// アプリから写真を受け取り、Claude の API に送って読み取り結果を返す。
// API キーはこのファイルには書かない。Cloudflare の「設定」→「変数とシークレット」に入れる：
//   ANTHROPIC_API_KEY … Claude の API キー（必須・種類は「シークレット」）
//   MODEL            … 使うモデル（任意。書かなければ claude-sonnet-5-5）

const FIREBASE_API_KEY = 'AIzaSyBsA66C0IQ5Jg-7cG2chorHzRViC8ApgcA';
const STAFF_EMAIL = 'staff@example.com';
const ALLOWED_ORIGIN = 'https://gtkg07-lab.github.io';
const MAX_IMAGES = 3;
const MAX_PROMPT_CHARS = 100000;

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    };
    const reply = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method === 'GET') return reply({ ok: true }); // 動いているかの確認用
    if (request.method !== 'POST') return reply({ error: 'bad_request' }, 405);

    try {
      const req = JSON.parse(await request.text());

      // 1. 合言葉で入った担任助手からの依頼か確かめる（アプリのログイン証明を Firebase に問い合わせる）
      const who = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_API_KEY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: String(req.idToken || '') })
      });
      const users = who.ok ? ((await who.json()).users || []) : [];
      if (!users.length || users[0].email !== STAFF_EMAIL) return reply({ error: 'auth' });

      // 2. 中身を確かめる
      // 写真の読み取りは写真1〜3枚。分析のまとめ（mode: 'text'）は写真なし
      const images = Array.isArray(req.images) ? req.images : [];
      const textOnly = req.mode === 'text';
      if ((!textOnly && !images.length) || images.length > MAX_IMAGES || typeof req.prompt !== 'string' || req.prompt.length > MAX_PROMPT_CHARS) {
        return reply({ error: 'bad_request' });
      }
      if (!env.ANTHROPIC_API_KEY) return reply({ error: 'no_key' });

      // 3. Claude に読み取りを頼む
      const content = images.map(d => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: String(d) } }))
        .concat([{ type: 'text', text: req.prompt }]);
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'server-side-fallback-2026-07-01'
        },
        body: JSON.stringify({
          model: env.MODEL || 'claude-sonnet-5-5',
          max_tokens: 16000,
          fallbacks: 'default', // 安全確認で断られたとき、別のモデルで自動的にやり直す
          messages: [{ role: 'user', content }]
        })
      });
      let j = {};
      try { j = await res.json(); } catch (e) {}
      if (res.status === 429 || res.status === 529) return reply({ error: 'rate_limited' });
      if (!res.ok) return reply({ error: 'api', status: res.status, message: (j.error && j.error.message) || '' });
      if (j.stop_reason === 'refusal') return reply({ error: 'refused' });

      const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      return reply({ text, stop_reason: j.stop_reason, usage: j.usage });
    } catch (e) {
      return reply({ error: 'server', message: String(e) });
    }
  }
};
