// 生徒進捗ノート：写真の読み取りの中継（Google Apps Script）
// アプリから写真を受け取り、Claude の API に送って読み取り結果を返す。
// API キーはこのファイルには書かない。「プロジェクトの設定」→「スクリプト プロパティ」に入れる：
//   ANTHROPIC_API_KEY … Claude の API キー（必須）
//   MODEL            … 使うモデル（任意。書かなければ claude-sonnet-5-5）

const FIREBASE_API_KEY = 'AIzaSyBsA66C0IQ5Jg-7cG2chorHzRViC8ApgcA';
const STAFF_EMAIL = 'staff@example.com';
const MAX_IMAGES = 3;
const MAX_PROMPT_CHARS = 100000;

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);

    // 1. 合言葉で入った担任助手からの依頼か確かめる（アプリのログイン証明を Firebase に問い合わせる）
    const who = UrlFetchApp.fetch(
      'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_API_KEY,
      { method: 'post', contentType: 'application/json', payload: JSON.stringify({ idToken: String(req.idToken || '') }), muteHttpExceptions: true });
    const users = who.getResponseCode() === 200 ? (JSON.parse(who.getContentText()).users || []) : [];
    if (!users.length || users[0].email !== STAFF_EMAIL) return reply({ error: 'auth' });

    // 2. 中身を確かめる
    const images = Array.isArray(req.images) ? req.images : [];
    if (!images.length || images.length > MAX_IMAGES || typeof req.prompt !== 'string' || req.prompt.length > MAX_PROMPT_CHARS) {
      return reply({ error: 'bad_request' });
    }

    // 3. Claude に読み取りを頼む
    const props = PropertiesService.getScriptProperties();
    const apiKey = props.getProperty('ANTHROPIC_API_KEY');
    if (!apiKey) return reply({ error: 'no_key' });
    const content = images.map(function (d) {
      return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: String(d) } };
    }).concat([{ type: 'text', text: req.prompt }]);
    const body = {
      model: props.getProperty('MODEL') || 'claude-sonnet-5-5',
      max_tokens: 16000,
      fallbacks: 'default', // 安全確認で断られたとき、別のモデルで自動的にやり直す
      messages: [{ role: 'user', content: content }]
    };
    const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'server-side-fallback-2026-07-01'
      },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    let j = {};
    try { j = JSON.parse(res.getContentText()); } catch (err) {}
    if (code === 429 || code === 529) return reply({ error: 'rate_limited' });
    if (code !== 200) return reply({ error: 'api', status: code, message: (j.error && j.error.message) || '' });
    if (j.stop_reason === 'refusal') return reply({ error: 'refused' });

    const text = (j.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
    return reply({ text: text, stop_reason: j.stop_reason, usage: j.usage });
  } catch (err) {
    return reply({ error: 'server', message: String(err) });
  }
}

// 動いているかの確認用（ブラウザでURLを開くと ok と出る）
function doGet() {
  return reply({ ok: true });
}

function reply(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
