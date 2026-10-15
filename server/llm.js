// Claude API: 한국어 프리셋 설명 → 구체적인 영어 음악 프롬프트(+제외 태그·주제·배경 검색어) 자동 생성
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { DIRS } from './paths.js';
import { isKnownTag } from './providers/treblo.js';

export const LLM_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

let topTagsCache = null;
function topTags(n = 220) {
  if (topTagsCache) return topTagsCache;
  try { topTagsCache = fs.readFileSync(path.join(DIRS.presets, '_treblo-tags.txt'), 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, n); }
  catch { topTagsCache = []; }
  return topTagsCache;
}

function makeClient(cfg) {
  const apiKey = cfg?.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey && !process.env.ANTHROPIC_AUTH_TOKEN) {
    const e = new Error('Claude API 키가 없습니다. 설정의 "Claude(Anthropic) API 키"에 입력하세요. (https://platform.claude.com)');
    e.code = 'NO_KEY'; throw e;
  }
  return apiKey ? new Anthropic({ apiKey }) : new Anthropic();
}

const SYSTEM = `You write generation prompts for Treblo (formerly Sonauto), an AI music generator similar to Suno.
Given a Korean description of a music style, produce a precise English prompt a professional music producer would write:
genre and sub-genre, era/reference sound (no real artist names), instruments and their playing style, tempo as a BPM range,
groove/rhythm feel, vocal character and delivery (or "instrumental, no vocals"), mood, production texture, song structure hints.
Write 2–4 dense sentences, 60–140 words. Keep every concrete detail from the Korean text; add idiomatic musical vocabulary; do not invent a different style.
Respond with JSON only (no markdown fences) with these keys:
{
  "prompt": string (the English prompt),
  "description": string (one Korean sentence summarizing the style, ≤ 60 chars),
  "negative_tags": string[] (3–5 tags the model should AVOID, chosen ONLY from the allowed tag list given by the user; lowercase exact spelling),
  "imageQueries": string[] (5 English photo search queries of 2–3 words that fit the mood, no people),
  "topics": { "ko": string[12], "en": string[12], "ja": string[12] } (evocative song titles/themes matching the style; each ≤ 18 chars; same ideas across languages)
}`;

/**
 * @returns {{prompt, description, negative_tags, imageQueries, topics, model, usage}}
 */
export async function generatePresetFromKorean({ koDescription, name = '', instrumental = false, wantTopics = true, cfg }) {
  if (!koDescription?.trim()) throw new Error('한국어 설명이 비어 있습니다');
  const client = makeClient(cfg);
  const model = LLM_MODELS.includes(cfg?.anthropic?.model) ? cfg.anthropic.model : 'claude-opus-5-5';
  const user = [
    `Preset name: ${name || '(none)'}`,
    `Instrumental: ${instrumental ? 'yes (no vocals)' : 'no (has vocals)'}`,
    `Include topics: ${wantTopics ? 'yes' : 'no (return empty arrays)'}`,
    `Korean style description:\n${koDescription.trim()}`,
    `Allowed tags for negative_tags (pick only from these): ${topTags().join(', ')}`,
  ].join('\n\n');

  const res = await client.beta.messages.create({
    model,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low' },
    system: SYSTEM,
    messages: [{ role: 'user', content: user }],
  });
  if (res.stop_reason === 'refusal') throw new Error(`모델이 요청을 거절했습니다 (${res.stop_details?.category || '사유 미상'})`);
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  const json = extractJson(text);
  if (!json?.prompt) throw new Error('응답에서 프롬프트를 찾지 못했습니다: ' + text.slice(0, 200));
  const neg = (json.negative_tags || []).map(t => String(t).trim().toLowerCase()).filter(t => t && isKnownTag(t)).slice(0, 5);
  const fix = (arr) => Array.isArray(arr) ? arr.map(s => String(s).trim()).filter(Boolean) : [];
  return {
    prompt: String(json.prompt).trim(),
    description: String(json.description || '').trim(),
    negative_tags: neg,
    imageQueries: fix(json.imageQueries).slice(0, 6),
    topics: { ko: fix(json.topics?.ko), en: fix(json.topics?.en), ja: fix(json.topics?.ja) },
    model: res.model, usage: { input: res.usage?.input_tokens, output: res.usage?.output_tokens },
  };
}

function extractJson(text) {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e < 0) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}

export function describeError(e) {
  if (e?.code === 'NO_KEY') return e.message;
  if (e instanceof Anthropic.AuthenticationError) return 'Claude API 키가 올바르지 않습니다.';
  if (e instanceof Anthropic.RateLimitError) return 'Claude API 사용량 한도에 걸렸습니다. 잠시 후 다시 시도하세요.';
  if (e instanceof Anthropic.BadRequestError) return 'Claude API 요청 오류: ' + e.message;
  if (e instanceof Anthropic.APIError) return `Claude API 오류 ${e.status}: ${e.message}`;
  return e?.message || String(e);
}
