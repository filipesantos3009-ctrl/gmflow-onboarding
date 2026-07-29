/**
 * POST /api/onboarding
 *
 * Recebe o formulário da secção 8 e grava o registo no Airtable.
 *
 * O token NUNCA chega ao browser: vive apenas em process.env, configurado em
 * Vercel → Settings → Environment Variables.
 *
 * Variáveis necessárias:
 *   AIRTABLE_TOKEN     (obrigatória)  PAT com scope data.records:write
 *   AIRTABLE_BASE_ID   (opcional)     default: app8jKzf1mSn3mv8l
 *   AIRTABLE_TABLE     (opcional)     default: GM Flow — Onboarding
 */

const DEFAULT_BASE = 'app8jKzf1mSn3mv8l';
const DEFAULT_TABLE = 'GM Flow — Onboarding';

const LIMITS = {
  nome: 120,
  email: 160,
  telemovel: 40,
  nif: 20,
  morada: 300,
  iban: 60,
  faculdade: 160,
  curso: 160,
};

const REQUIRED = ['nome', 'email', 'telemovel', 'nif', 'morada', 'iban'];

const clean = (value, max) =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const token = process.env.AIRTABLE_TOKEN;
  if (!token) {
    console.error('AIRTABLE_TOKEN não está definida nas Environment Variables.');
    return res.status(500).json({ error: 'Servidor mal configurado' });
  }

  // O body chega já parseado quando o Content-Type é application/json.
  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};

  const input = {};
  for (const [key, max] of Object.entries(LIMITS)) input[key] = clean(body[key], max);

  const missing = REQUIRED.filter((key) => !input[key]);
  if (missing.length) {
    return res.status(400).json({ error: 'Campos obrigatórios em falta', missing });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(input.email)) {
    return res.status(400).json({ error: 'Email inválido' });
  }

  const fields = {
    'Nome Completo': input.nome,
    'Email': input.email,
    'Telemóvel': input.telemovel,
    'NIF': input.nif,
    'Morada': input.morada,
    'IBAN': input.iban,
    'Data de Submissão': new Date().toISOString().slice(0, 10),
  };
  if (input.faculdade) fields['Faculdade'] = input.faculdade;
  if (input.curso) fields['Curso'] = input.curso;

  const baseId = process.env.AIRTABLE_BASE_ID || DEFAULT_BASE;
  const table = process.env.AIRTABLE_TABLE || DEFAULT_TABLE;
  const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`;

  try {
    const airtable = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields }),
    });

    if (!airtable.ok) {
      // Log fica nas Vercel Functions Logs; a resposta ao cliente não revela detalhes.
      console.error('Airtable respondeu', airtable.status, await airtable.text());
      return res.status(502).json({ error: 'Não foi possível gravar o registo' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Erro ao contactar o Airtable:', err);
    return res.status(502).json({ error: 'Não foi possível gravar o registo' });
  }
}

function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    return {};
  }
}
