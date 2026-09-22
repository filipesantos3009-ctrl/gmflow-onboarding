/**
 * POST /api/onboarding
 *
 * Recebe o formulário da secção 8 e manda os dados ao Filipe por DM no Slack.
 *
 * O Slack é o destino. O Airtable é opcional e está desligado por omissão:
 * só é usado se AIRTABLE_TABLE apontar para uma tabela que já exista. Nada
 * aqui cria tabelas nem campos.
 *
 * Os tokens NUNCA chegam ao browser: vivem em process.env, configurados em
 * Vercel → Settings → Environment Variables.
 *
 * Variáveis:
 *   SLACK_BOT_TOKEN    (obrigatória)  bot token (xoxb-) com scope chat:write
 *   SLACK_AVISO_PARA   (opcional)     default: U09UW9UHLGG (Filipe Almeida)
 *   AIRTABLE_TABLE     (opcional)     nome da tabela. Vazio = não grava
 *   AIRTABLE_TOKEN     (só com a de cima)  PAT com scope data.records:write
 *   AIRTABLE_BASE_ID   (opcional)     default: app8jKzf1mSn3mv8l
 */

const DEFAULT_BASE = 'app8jKzf1mSn3mv8l';
const DEFAULT_AVISO_PARA = 'U09UW9UHLGG'; // Filipe Almeida

/**
 * Os campos pela ordem das colunas da tabela Equipa do Airtable
 * (Nome · NIF · IBAN · Email · Telemóvel), e a seguir os que essa tabela não
 * tem. É esta a ordem da mensagem do Slack e do registo, para se lerem os dois
 * da mesma maneira.
 */
const CAMPOS = [
  { chave: 'nome', etiqueta: 'Nome', max: 120, obrigatorio: true },
  { chave: 'nif', etiqueta: 'NIF', max: 20, obrigatorio: true },
  { chave: 'iban', etiqueta: 'IBAN', max: 60, obrigatorio: true },
  { chave: 'email', etiqueta: 'Email', max: 160, obrigatorio: true },
  { chave: 'telemovel', etiqueta: 'Telemóvel', max: 40, obrigatorio: true },
  { chave: 'morada', etiqueta: 'Morada', max: 300, obrigatorio: true },
  { chave: 'faculdade', etiqueta: 'Faculdade', max: 160, obrigatorio: false },
  { chave: 'curso', etiqueta: 'Curso', max: 160, obrigatorio: false },
];

const clean = (value, max) =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método não permitido' });
  }

  if (!process.env.SLACK_BOT_TOKEN) {
    console.error('SLACK_BOT_TOKEN não está definida nas Environment Variables.');
    return res.status(500).json({ error: 'Servidor mal configurado' });
  }

  // O body chega já parseado quando o Content-Type é application/json.
  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};

  const input = {};
  for (const campo of CAMPOS) input[campo.chave] = clean(body[campo.chave], campo.max);

  const missing = CAMPOS.filter((c) => c.obrigatorio && !input[c.chave]).map((c) => c.chave);
  if (missing.length) {
    return res.status(400).json({ error: 'Campos obrigatórios em falta', missing });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(input.email)) {
    return res.status(400).json({ error: 'Email inválido' });
  }

  const data = new Date().toISOString().slice(0, 10);

  // O Slack é o destino: se falhar, os dados perdem-se e quem preencheu tem de
  // saber. Por isso este erro sobe, ao contrário do Airtable mais abaixo.
  const enviado = await enviarParaSlack(input, data);
  if (!enviado) {
    return res.status(502).json({ error: 'Não foi possível registar os dados' });
  }

  // Opcional e desligado por omissão. Um erro aqui não falha o pedido: os dados
  // já chegaram ao Filipe.
  await gravarNoAirtable(input, data);

  return res.status(200).json({ ok: true });
};

function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    return {};
  }
}

/**
 * Manda a DM ao Filipe com os dados, um campo por linha.
 * Devolve true se o Slack confirmou a entrega.
 */
async function enviarParaSlack(input, data) {
  const para = process.env.SLACK_AVISO_PARA || DEFAULT_AVISO_PARA;

  const linhas = CAMPOS
    .filter((c) => input[c.chave])
    .map((c) => `*${c.etiqueta}:* ${input[c.chave]}`)
    .join('\n');

  try {
    const resposta = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        channel: para,
        text: `Novo onboarding preenchido: ${input.nome}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:clipboard: *Novo onboarding preenchido* — ${data}\n\n${linhas}`,
            },
          },
        ],
      }),
    });

    // O Slack responde 200 mesmo quando recusa; o que conta é o campo "ok".
    const corpo = await resposta.json();
    if (!corpo.ok) {
      console.error('Slack recusou a mensagem:', corpo.error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Não foi possível contactar o Slack:', err);
    return false;
  }
}

/**
 * Grava no Airtable, se e só se AIRTABLE_TABLE estiver configurada com o nome
 * de uma tabela que já exista. Nunca lança.
 */
async function gravarNoAirtable(input, data) {
  const table = process.env.AIRTABLE_TABLE;
  const token = process.env.AIRTABLE_TOKEN;
  if (!table || !token) return; // Desligado: é o estado normal.

  const fields = { 'Data de Submissão': data };
  for (const campo of CAMPOS) {
    if (input[campo.chave]) fields[campo.etiqueta] = input[campo.chave];
  }

  const baseId = process.env.AIRTABLE_BASE_ID || DEFAULT_BASE;
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
      console.error('Airtable respondeu', airtable.status, await airtable.text());
    }
  } catch (err) {
    console.error('Erro ao contactar o Airtable:', err);
  }
}
