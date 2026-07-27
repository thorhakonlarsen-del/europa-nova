#!/usr/bin/env node
/**
 * Europa Nova — Policy Context feed updater.
 *
 * Runs from GitHub Actions (.github/workflows/news-feed.yml):
 *   1. fetches a set of policy/institutional RSS feeds
 *   2. drops anything already in news.json's `seen` list, or older than WINDOW_DAYS
 *   3. asks Claude to pick the items that matter for European AI sovereignty
 *      and write commentary in the site's voice
 *   4. prepends the new items to news.json, keeping an archive of MAX_ITEMS
 *
 * The archive is never truncated to the size of a single run — a run that finds
 * nothing still rewrites `updated`, which doubles as the heartbeat that keeps
 * GitHub's scheduled workflows from being auto-disabled after 60 days.
 *
 *   node scripts/update-news.mjs            # full run (needs ANTHROPIC_API_KEY)
 *   node scripts/update-news.mjs --dry-run  # fetch + parse + dedupe only, no API call, no write
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const NEWS_PATH = join(HERE, '..', 'news.json');

const DRY_RUN = process.argv.includes('--dry-run');

// How far back a feed item may be dated and still be considered. The workflow
// runs Mon+Thu, so 21 days is generous slack for a missed or failed run.
const WINDOW_DAYS = 21;
// Items shown on the site. Older ones fall off the bottom but stay in `seen`.
const MAX_ITEMS = 24;
// URLs remembered so a dropped item can never re-enter the feed.
const MAX_SEEN = 400;
// Upper bound on how many items one run may add.
const MAX_NEW_PER_RUN = 3;
// Upper bound on candidates sent to the model.
const MAX_CANDIDATES = 40;

// Verified live 2026-07-27. A dead feed is logged and skipped, never fatal —
// but a source that logs "0 items" for weeks has probably moved.
const SOURCES = [
  { name: 'European Commission — Digital Strategy', url: 'https://digital-strategy.ec.europa.eu/en/rss.xml' },
  { name: 'European Commission — Press Corner', url: 'https://ec.europa.eu/commission/presscorner/api/rss?language=en' },
  { name: 'ECB Banking Supervision — Press', url: 'https://www.bankingsupervision.europa.eu/rss/press.html' },
  { name: 'ECB Banking Supervision — Publications', url: 'https://www.bankingsupervision.europa.eu/rss/pub.html' },
  { name: 'ESRB', url: 'https://www.esrb.europa.eu/rss/press.xml' },
  { name: 'ECB', url: 'https://www.ecb.europa.eu/rss/press.html' },
  { name: 'EBA', url: 'https://www.eba.europa.eu/rss.xml' },
  // Not /news/rss.xml — that variant ships no <pubDate> at all, so every item
  // fails the window check and the feed silently contributes nothing.
  { name: 'FCA', url: 'https://www.fca.org.uk/rss.xml' },
  { name: 'Bruegel', url: 'https://www.bruegel.org/rss.xml' },
  { name: 'Google News — sovereign AI Europe', url: 'https://news.google.com/rss/search?q=%22sovereign+AI%22+Europe+OR+%22AI+gigafactory%22+OR+%22AI+Continent%22&hl=en-GB&gl=GB&ceid=GB:en' },
  { name: 'Google News — European AI compute', url: 'https://news.google.com/rss/search?q=%22CERN+for+AI%22+OR+%22European+AGI%22+OR+%22AI+sovereignty%22+EU&hl=en-GB&gl=GB&ceid=GB:en' },
];

const SYSTEM_PROMPT = `You are the policy editor for Europa Nova, a proposal for a treaty-based European institution for sovereign frontier AI development, modelled on CERN and financed in part through Norway's sovereign wealth fund.

You are given recent items from European institutional and policy feeds. Select only those that genuinely bear on European AI sovereignty, and write commentary on each.

Relevant:
- European sovereign AI capability, strategic autonomy, and technology dependency
- AI compute infrastructure, data centres, gigafactories, Nordic energy for AI
- Frontier model development, AI safety and governance frameworks
- EU AI policy (AI Act, AI Continent Action Plan, AI Factories, Cloud and AI Development Act, InvestAI)
- Systemic and financial-stability risk arising from AI, where the dependency on non-European model providers is part of the story
- Geopolitical AI competition between the US, Europe, and China
- Treaty-based technology cooperation (CERN, ESA, Galileo precedents)
- Sovereign wealth fund investment in technology
- AI talent, brain drain, and research institutions
- Norway, Sweden, Finland: AI policy and energy infrastructure

Not relevant: routine supervisory statistics, personnel announcements, prize awards, conference logistics, general macroeconomic commentary, and anything about AI that has no European institutional or sovereignty dimension.

For each selected item write commentary of exactly 3-4 sentences that:
- states what happened and why it bears on European AI sovereignty specifically
- is analytical and forward-looking, not journalistic summary
- stays strictly within what the source material supports — never invent figures, dates, quotes, or commitments
- avoids buzzwords: no synergy, paradigm shift, game-changing, crucial, holistic, landmark
- never begins with "I" or "This"
- ends on a forward-looking observation or implication

Use British spelling. Write "EUR 20 billion", not "€20bn". Copy the title and URL verbatim from the item you were given. Use the item's own publication date in YYYY-MM-DD form.

Select at most ${MAX_NEW_PER_RUN} items — the most consequential ones. Selecting fewer, or none at all, is correct and expected when nothing in the batch clears the bar. Never pad the list to reach the maximum.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Publication date, YYYY-MM-DD' },
          source: { type: 'string', description: 'Issuing body or publication' },
          title: { type: 'string', description: 'Article title, verbatim' },
          url: { type: 'string', description: 'Article URL, verbatim' },
          commentary: { type: 'string', description: '3-4 sentences of analysis' },
        },
        required: ['date', 'source', 'title', 'url', 'commentary'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

// Cheap deterministic gate applied before the model sees anything. The
// institutional feeds carry mostly monetary policy, State aid and supervisory
// statistics; without this, ~two thirds of every batch is noise the model has
// to read and reject. Matched against title + summary.
// Note `\bAI\b` is case-sensitive on purpose — a case-insensitive match hits
// "said", "domain", "available".
const TOPIC_PATTERNS = [
  /\bAI\b/,
  /\bAGI\b/,
  /artificial intelligence/i,
  /machine learning|frontier model|foundation model|large language model|\bLLM\b/i,
  /data cent(re|er)|gigafactory|supercomput|\bGPU\b|compute capacity|cloud comput/i,
  /digital sovereignty|tech(nological)? sovereignty|sovereign AI|strategic autonomy|digital dependenc/i,
  /semiconductor|microchip|chip(s)? act/i,
  /Mistral|OpenAI|Anthropic|DeepMind|Nvidia|Aleph Alpha|Hugging Face/i,
  /cyber ?(security|resilience|threat|attack)/i,
];

const isOnTopic = (item) => {
  const haystack = `${item.title}\n${item.summary}`;
  return TOPIC_PATTERNS.some((re) => re.test(haystack));
};

/**
 * Feeds are inconsistent about date format. RFC 822 and ISO 8601 parse
 * natively; the FCA publishes "Monday, July 27, 2026 - 15:30", which Date
 * rejects outright because of the dash.
 */
function parseDate(raw) {
  if (!raw) return null;
  const candidates = [raw, raw.replace(/\s+-\s+/, ' ')];
  for (const c of candidates) {
    const d = new Date(c);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

const log = (...args) => console.log(...args);

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function extractTag(xml, tag) {
  const cdata = xml.match(new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i'));
  if (cdata) return decodeEntities(cdata[1]).trim();
  const plain = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (plain) return decodeEntities(plain[1].replace(/<[^>]*>/g, '')).trim();
  return '';
}

/** Atom uses <link href="..."/>; RSS uses <link>...</link>. Try both. */
function extractLink(itemXml) {
  const rss = extractTag(itemXml, 'link');
  if (rss && /^https?:/i.test(rss)) return rss;
  const atom = itemXml.match(/<link[^>]*href="([^"]+)"/i);
  return atom ? decodeEntities(atom[1]) : '';
}

async function fetchFeed(source) {
  try {
    const res = await fetch(source.url, {
      signal: AbortSignal.timeout(25_000),
      headers: {
        // Several institutional feeds 403 a bare fetch() user agent.
        'user-agent': 'Mozilla/5.0 (compatible; europa-nova-newsbot/1.0; +https://europa-nova.eu)',
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
    if (!res.ok) {
      log(`  ! ${source.name}: HTTP ${res.status}`);
      return [];
    }
    const xml = await res.text();
    const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
    const cutoff = Date.now() - WINDOW_DAYS * 86_400_000;
    const items = [];

    for (const block of blocks) {
      const title = extractTag(block, 'title');
      const link = extractLink(block);
      if (!title || !link) continue;

      const raw =
        extractTag(block, 'pubDate') ||
        extractTag(block, 'published') ||
        extractTag(block, 'updated') ||
        extractTag(block, 'dc:date');
      const date = parseDate(raw);
      // No parseable date means we cannot honour the window, and dating an item
      // by when we happened to fetch it would put a wrong date on the site.
      // Skip, and let the per-source count below expose a feed that never dates
      // anything.
      if (!date || date.getTime() < cutoff) continue;

      const summary = (extractTag(block, 'description') || extractTag(block, 'summary')).slice(0, 500);
      items.push({ title, link, date: date.toISOString(), summary, source: source.name });
    }

    const onTopic = items.filter(isOnTopic);
    log(`  · ${source.name}: ${onTopic.length} on topic (${items.length} in window, ${blocks.length} total)`);
    return onTopic;
  } catch (err) {
    log(`  ! ${source.name}: ${err.message}`);
    return [];
  }
}

function normaliseUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    // Strip tracking params so the same article under two links dedupes.
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|oc$)/i.test(p)) u.searchParams.delete(p);
    }
    return u.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

async function askClaude(candidates) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();

  const list = candidates
    .map((c, i) => `${i + 1}. TITLE: ${c.title}\nSOURCE: ${c.source}\nDATE: ${c.date.slice(0, 10)}\nURL: ${c.link}\nSUMMARY: ${c.summary}`)
    .join('\n\n');

  const response = await client.messages.create({
    model: 'claude-opus-5',
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    output_config: {
      format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
      effort: 'high',
    },
    messages: [
      {
        role: 'user',
        content: `Here are ${candidates.length} recent items. Select the ones that matter for European AI sovereignty and write commentary for each.\n\n${list}`,
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error(`model declined the request (${response.stop_details?.category ?? 'no category'})`);
  }
  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('no text block in response');

  log(`  · tokens: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out`);
  return JSON.parse(text).items ?? [];
}

/** The schema guarantees shape, not truthfulness — check the model kept to the source list. */
function validate(items, candidates) {
  const known = new Map(candidates.map((c) => [normaliseUrl(c.link), c]));
  const kept = [];

  for (const item of items) {
    const key = normaliseUrl(item.url ?? '');
    if (!known.has(key)) {
      log(`  ! dropped (url not in candidate list): ${item.title}`);
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date ?? '')) {
      log(`  ! dropped (bad date "${item.date}"): ${item.title}`);
      continue;
    }
    const words = (item.commentary ?? '').trim().split(/\s+/).length;
    if (words < 25) {
      log(`  ! dropped (commentary too short, ${words} words): ${item.title}`);
      continue;
    }
    kept.push({
      date: item.date,
      source: item.source.trim(),
      title: item.title.trim(),
      url: item.url.trim(),
      commentary: item.commentary.trim(),
    });
  }
  return kept.slice(0, MAX_NEW_PER_RUN);
}

async function main() {
  const news = JSON.parse(readFileSync(NEWS_PATH, 'utf8'));
  const items = news.items ?? [];
  // Older news.json files predate `seen`; seed it from what is on the site.
  const seen = new Set([...(news.seen ?? []), ...items.map((i) => normaliseUrl(i.url))]);

  log(`Existing: ${items.length} items, ${seen.size} URLs seen.`);
  log('Fetching feeds…');

  const fetched = (await Promise.all(SOURCES.map(fetchFeed))).flat();

  const byUrl = new Map();
  for (const item of fetched) {
    const key = normaliseUrl(item.link);
    if (seen.has(key) || byUrl.has(key)) continue;
    byUrl.set(key, item);
  }
  const candidates = [...byUrl.values()]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, MAX_CANDIDATES);

  log(`\n${fetched.length} items fetched, ${candidates.length} unseen candidates.`);

  if (DRY_RUN) {
    for (const c of candidates) log(`  ${c.date.slice(0, 10)}  [${c.source}]  ${c.title}`);
    log('\nDry run — no API call, no write.');
    return;
  }

  let selected = [];
  if (candidates.length === 0) {
    log('Nothing new to review.');
  } else {
    log('Asking Claude to select and annotate…');
    selected = validate(await askClaude(candidates), candidates);
    log(`Selected ${selected.length} item(s).`);
    for (const s of selected) log(`  + ${s.date}  ${s.title}`);
  }

  // Every candidate is marked seen, selected or not — a rejected item should
  // not be re-reviewed (and re-billed) on every subsequent run.
  for (const c of candidates) seen.add(normaliseUrl(c.link));

  const merged = [...selected, ...items].slice(0, MAX_ITEMS);

  writeFileSync(
    NEWS_PATH,
    JSON.stringify(
      {
        updated: new Date().toISOString(),
        items: merged,
        seen: [...seen].slice(-MAX_SEEN),
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  log(`\nWrote news.json — ${merged.length} items, ${Math.min(seen.size, MAX_SEEN)} URLs remembered.`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      `### Policy Context feed`,
      ``,
      `- candidates reviewed: **${candidates.length}**`,
      `- items added: **${selected.length}**`,
      `- items on site: **${merged.length}**`,
      ``,
      ...selected.map((s) => `- ${s.date} — [${s.title}](${s.url})`),
    ];
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n', { flag: 'a' });
  }
}

await main();
