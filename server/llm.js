// 메인 LLM (Claude / OpenAI / Gemini 중 하나를 선택해 사용)
//  - 한국어 프리셋 설명 → 영어 음악 프롬프트(+제외 태그·주제·배경 검색어) 생성
//  - 작업 시작 시 한국어 요청 → 영어 번역, 배경 사진 검색어 기획·후보 선별 (경량 모델)
// 세 제공자 모두 "system + user 한 번 → JSON 텍스트" 형태로만 쓰므로 chat() 한 함수로 추상화한다.
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { DIRS } from './paths.js';
import { isKnownTag } from './providers/treblo.js';

export const LLM_PROVIDERS = {
  anthropic: { label: 'Claude (Anthropic)', env: 'ANTHROPIC_API_KEY', site: 'https://platform.claude.com', keyHint: 'sk-ant-…',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], defaultModel: 'claude-opus-5-5', defaultCheap: 'claude-haiku-5-5' },
  openai: { label: 'OpenAI', env: 'OPENAI_API_KEY', site: 'https://platform.openai.com/api-keys', keyHint: 'sk-…',
    models: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano'], defaultModel: 'gpt-5.4', defaultCheap: 'gpt-5.4-mini' },
  gemini: { label: 'Gemini (Google)', env: 'GEMINI_API_KEY', site: 'https://aistudio.google.com/apikey', keyHint: 'AIza…',
    models: ['gemini-3.1-pro-preview', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'], defaultModel: 'gemini-3.6-flash', defaultCheap: 'gemini-3.5-flash-lite' },
};
export const LLM_MODELS = LLM_PROVIDERS.anthropic.models;   // 하위 호환
const HANGUL = /[가-힣]/;
const OPENAI_BASE = 'https://api.openai.com/v1';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** 현재 메인 LLM 제공자 id */
export function llmProvider(cfg) { return LLM_PROVIDERS[cfg?.llm?.provider] ? cfg.llm.provider : 'anthropic'; }
/** 제공자의 API 키 (설정 → 환경변수 → Gemini 는 Lyria 키 공유) */
export function llmKey(cfg, id = llmProvider(cfg)) {
  const m = LLM_PROVIDERS[id]; if (!m) return '';
  let k = cfg?.[id]?.apiKey || process.env[m.env] || '';
  if (!k && id === 'gemini') k = cfg?.lyria?.apiKey || '';
  return k;
}
export function hasLlmKey(cfg, id = llmProvider(cfg)) { return Boolean(llmKey(cfg, id)) || (id === 'anthropic' && Boolean(process.env.ANTHROPIC_AUTH_TOKEN)); }
/** 모델 id. cheap=true 면 번역·선별용 경량 모델 */
export function llmModel(cfg, cheap = false, id = llmProvider(cfg)) {
  const m = LLM_PROVIDERS[id] || LLM_PROVIDERS.anthropic;
  const v = cheap ? cfg?.[id]?.cheapModel : cfg?.[id]?.model;
  return (typeof v === 'string' && v.trim()) ? v.trim() : (cheap ? m.defaultCheap : m.defaultModel);
}

let topTagsCache = null;
function topTags(n = 220) {
  if (topTagsCache) return topTagsCache;
  try { topTagsCache = fs.readFileSync(path.join(DIRS.presets, '_treblo-tags.txt'), 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, n); }
  catch { topTagsCache = []; }
  return topTagsCache;
}

function noKeyError(id) {
  const m = LLM_PROVIDERS[id];
  const e = new Error(`${m.label} API 키가 없습니다. 상단 [설정] → 메인 LLM 카드에 키를 등록하세요. (${m.site})`);
  e.code = 'NO_KEY'; return e;
}
function makeAnthropic(cfg) {
  const apiKey = llmKey(cfg, 'anthropic');
  if (!apiKey && !process.env.ANTHROPIC_AUTH_TOKEN) throw noKeyError('anthropic');
  return apiKey ? new Anthropic({ apiKey }) : new Anthropic();
}

/** fetch + JSON. 실패 시 {status, provider} 가 붙은 Error */
async function httpJson(url, { method = 'GET', headers = {}, body, timeoutMs = 90_000, provider } = {}) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method, headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: ac.signal });
    const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    if (!r.ok) {
      const msg = data?.error?.message || (typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300));
      throw Object.assign(new Error(`HTTP ${r.status} ${msg}`), { status: r.status, provider });
    }
    return data;
  } finally { clearTimeout(t); }
}

/**
 * 공통 채팅 호출: system + user → 텍스트. 반환 {text, model, usage:{input,output}}
 */
export async function chat({ cfg, system, user, maxTokens = 2000, cheap = false, provider = llmProvider(cfg) }) {
  const model = llmModel(cfg, cheap, provider);
  if (provider === 'anthropic') {
    const client = makeAnthropic(cfg);
    const res = await client.beta.messages.create({
      model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }],
      betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', output_config: { effort: 'low' },   // 기존 프리셋 생성 호출과 동일한 설정
    });
    if (res.stop_reason === 'refusal') throw new Error(`모델이 요청을 거절했습니다 (${res.stop_details?.category || '사유 미상'})`);
    if (res.stop_reason === 'max_tokens') throw new Error(`응답이 max_tokens(${maxTokens})에서 잘렸습니다`);
    return { text: res.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim(), model: res.model, usage: { input: res.usage?.input_tokens, output: res.usage?.output_tokens } };
  }
  const key = llmKey(cfg, provider); if (!key) throw noKeyError(provider);
  if (provider === 'openai') {
    const body = { model, max_completion_tokens: maxTokens, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
    if (/^(gpt-5|o\d)/i.test(model)) body.reasoning_effort = 'low';   // 추론 모델: 추론 토큰이 max_completion_tokens 를 다 먹지 않도록
    const d = await httpJson(`${OPENAI_BASE}/chat/completions`, { method: 'POST', provider, headers: { Authorization: `Bearer ${key}` }, body });
    const choice = d.choices?.[0] || {};
    const text = String(choice.message?.content || '').trim();
    if (choice.finish_reason === 'content_filter') throw new Error('모델이 요청을 거절했습니다');
    if (choice.finish_reason === 'length' && !text) throw new Error(`응답이 max_completion_tokens(${maxTokens})에서 잘렸습니다 (추론 토큰 포함). 경량 모델을 바꾸거나 다시 시도하세요`);
    return { text, model: d.model || model, usage: { input: d.usage?.prompt_tokens, output: d.usage?.completion_tokens } };
  }
  if (provider === 'gemini') {
    const d = await httpJson(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', provider, headers: { 'x-goog-api-key': key },
      body: { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { maxOutputTokens: maxTokens, responseMimeType: 'application/json' } } });
    const cand = d.candidates?.[0];
    if (!cand && d.promptFeedback?.blockReason) throw new Error(`모델이 요청을 거절했습니다 (${d.promptFeedback.blockReason})`);
    const text = (cand?.content?.parts || []).map(p => p.text || '').join('\n').trim();
    if (cand?.finishReason === 'MAX_TOKENS' && !text) throw new Error(`응답이 maxOutputTokens(${maxTokens})에서 잘렸습니다 (thinking 토큰 포함). 경량 모델을 바꾸거나 다시 시도하세요`);
    if (cand?.finishReason === 'SAFETY' || cand?.finishReason === 'PROHIBITED_CONTENT') throw new Error(`모델이 요청을 거절했습니다 (${cand.finishReason})`);
    return { text, model: d.modelVersion || model, usage: { input: d.usageMetadata?.promptTokenCount, output: d.usageMetadata?.candidatesTokenCount } };
  }
  throw new Error('알 수 없는 LLM 제공자: ' + provider);
}

/** 키 확인(토큰 소모 없음): 모델 메타데이터 조회 */
export async function checkLlmKey(cfg, id = llmProvider(cfg)) {
  const model = llmModel(cfg, false, id);
  if (id === 'anthropic') { const m = await makeAnthropic(cfg).models.retrieve(model); return { model: m.id || model, displayName: m.display_name || '' }; }
  const key = llmKey(cfg, id); if (!key) throw noKeyError(id);
  if (id === 'openai') { const m = await httpJson(`${OPENAI_BASE}/models/${encodeURIComponent(model)}`, { provider: id, headers: { Authorization: `Bearer ${key}` }, timeoutMs: 20_000 }); return { model: m.id || model, displayName: m.owned_by ? `owner ${m.owned_by}` : '' }; }
  if (id === 'gemini') { const m = await httpJson(`${GEMINI_BASE}/models/${encodeURIComponent(model)}`, { provider: id, headers: { 'x-goog-api-key': key }, timeoutMs: 20_000 }); return { model: (m.name || model).replace(/^models\//, ''), displayName: m.displayName || '' }; }
  throw new Error('알 수 없는 LLM 제공자: ' + id);
}

/** 제공자의 사용 가능한 모델 id 목록 (설정 모달의 모델 목록 버튼) */
export async function listLlmModels(cfg, id = llmProvider(cfg)) {
  if (id === 'anthropic') { const r = await makeAnthropic(cfg).models.list({ limit: 100 }); return (r.data || []).map(m => m.id).sort(); }
  const key = llmKey(cfg, id); if (!key) throw noKeyError(id);
  if (id === 'openai') { const r = await httpJson(`${OPENAI_BASE}/models`, { provider: id, headers: { Authorization: `Bearer ${key}` }, timeoutMs: 30_000 }); return (r.data || []).map(m => m.id).filter(x => /^(gpt|o\d)/.test(x) && !/(audio|realtime|tts|transcribe|image|embedding|moderation|search|computer|codex|instruct)/i.test(x)).sort(); }
  if (id === 'gemini') { const r = await httpJson(`${GEMINI_BASE}/models?pageSize=200`, { provider: id, headers: { 'x-goog-api-key': key }, timeoutMs: 30_000 }); return (r.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini/i.test(m.name) && !/(image|tts|audio|embedding|live|native-audio|robotics|computer-use)/i.test(m.name)).map(m => m.name.replace(/^models\//, '')).sort(); }
  throw new Error('알 수 없는 LLM 제공자: ' + id);
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
export async function generatePresetFromKorean({ koDescription, name = '', instrumental = false, wantTopics = true, cfg, call = null }) {
  if (!koDescription?.trim()) throw new Error('한국어 설명이 비어 있습니다');
  const user = [
    `Preset name: ${name || '(none)'}`,
    `Instrumental: ${instrumental ? 'yes (no vocals)' : 'no (has vocals)'}`,
    `Include topics: ${wantTopics ? 'yes' : 'no (return empty arrays)'}`,
    `Korean style description:\n${koDescription.trim()}`,
    `Allowed tags for negative_tags (pick only from these): ${topTags().join(', ')}`,
  ].join('\n\n');
  const r = await callJson({ cfg, system: SYSTEM, user, maxTokens: 4000, cheap: false, call });
  const json = r.json;
  if (!json?.prompt) throw new Error('응답에서 프롬프트를 찾지 못했습니다: ' + JSON.stringify(json).slice(0, 200));
  const neg = (json.negative_tags || []).map(t => String(t).trim().toLowerCase()).filter(t => t && isKnownTag(t)).slice(0, 5);
  const fix = (arr) => Array.isArray(arr) ? arr.map(s => String(s).trim()).filter(Boolean) : [];
  return {
    prompt: String(json.prompt).trim(),
    description: String(json.description || '').trim(),
    negative_tags: neg,
    imageQueries: fix(json.imageQueries).slice(0, 6),
    topics: { ko: fix(json.topics?.ko), en: fix(json.topics?.en), ja: fix(json.topics?.ja) },
    model: r.model, usage: r.usage,
  };
}

/** JSON 응답을 받는 공통 호출. opts.call 이 있으면 (테스트용) 그것으로 대체 */
async function callJson({ cfg, system, user, maxTokens = 2000, cheap = true, call = null }) {
  if (call) return call({ system, user });
  const r = await chat({ cfg, system, user, maxTokens, cheap });
  const json = extractJson(r.text);
  if (!json) throw new Error('JSON 응답 아님: ' + r.text.slice(0, 120));
  return { json, model: r.model, usage: r.usage };
}

/**
 * 한국어 문장들을 음악 생성 프롬프트용 영어로 번역. 한글이 없는 항목은 그대로 둔다.
 * @returns {{texts: string[], model?: string, usage?: object}}
 */
export async function translateToEnglish(texts, { cfg, call } = {}) {
  const out = texts.map(t => String(t ?? ''));
  const idx = out.map((t, i) => HANGUL.test(t) ? i : -1).filter(i => i >= 0);
  if (!idx.length) return { texts: out };
  const system = `You translate Korean notes for an AI music generator into natural, precise English.
Keep every concrete musical detail (genre, instruments, tempo/BPM, mood, vocal tone, era, structure, references). Do not add ideas, do not summarize, do not explain.
Respond with JSON only: {"translations": string[]} in the same order and count as the input.`;
  const user = JSON.stringify({ inputs: idx.map(i => out[i]) });
  const r = await callJson({ cfg, system, user, maxTokens: 2500, cheap: true, call });
  const tr = Array.isArray(r.json?.translations) ? r.json.translations : null;
  if (!tr || tr.length !== idx.length) throw new Error('번역 응답 형식 오류');
  idx.forEach((i, k) => { const t = String(tr[k] || '').trim(); if (t) out[i] = t; });
  return { texts: out, model: r.model, usage: r.usage };
}

/**
 * 작업별 배경 사진 기획: 곡 스타일·제목·가사로 사진 검색어와 피할 소재를 정한다.
 * @returns {{mood: string, queries: string[], avoid: string[], model?: string}}
 */
export async function planBackgroundQueries({ preset, tracks = [], instrumental = false, lang = 'ko', cfg, call } = {}) {
  const system = `You choose background photo search queries for a YouTube music playlist video (1920x1080 still photos behind the music).
Given the music style and the songs (titles, lyric excerpts), respond with JSON only:
{
  "mood": string (one English sentence: the visual mood/scene that fits this playlist),
  "queries": string[8] (English photo search queries of 2-4 words each; concrete SCENES, PLACES, OBJECTS, WEATHER, TIME OF DAY, LIGHT; varied but coherent; suitable for free stock photo sites like Unsplash; NO people, faces, text, logos, brands, maps, buildings' names),
  "avoid": string[3-6] (lowercase single words for subjects that would clash with the mood, e.g. "crowd", "stadium", "snow")
}`;
  const songs = tracks.slice(0, 12).map((t, i) => `${i + 1}. ${t.title}${t.lyrics ? ` — ${String(t.lyrics).slice(0, 160)}` : ''}`).join('\n');
  const user = [
    `Preset: ${preset?.name || ''}`, `Description: ${preset?.description || ''}`,
    preset?.koDescription ? `Style notes (Korean): ${String(preset.koDescription).slice(0, 600)}` : '',
    preset?.prompt ? `Music prompt: ${String(preset.prompt).slice(0, 500)}` : '',
    `Instrumental: ${instrumental ? 'yes' : 'no'} · Lyrics language: ${lang}`,
    preset?.imageQueries?.length ? `Preset's default photo queries (may reuse or improve): ${preset.imageQueries.join(', ')}` : '',
    `Songs:\n${songs || '(none)'}`,
  ].filter(Boolean).join('\n');
  const r = await callJson({ cfg, system, user, maxTokens: 2000, cheap: true, call });
  const fix = (a, n) => Array.isArray(a) ? a.map(s => String(s).trim()).filter(Boolean).slice(0, n) : [];
  const queries = fix(r.json?.queries, 10); if (!queries.length) throw new Error('검색어 없음');
  return { mood: String(r.json?.mood || '').trim(), queries, avoid: fix(r.json?.avoid, 8).map(s => s.toLowerCase()), model: r.model, usage: r.usage };
}

/**
 * 후보 사진(제목·설명)을 분위기 기준으로 고른다. 반환: 적합 순 id 배열(최대 count)
 */
export async function rankBackgrounds({ mood, candidates = [], count = 8, cfg, call } = {}) {
  if (!candidates.length) return [];
  const system = `You pick background photos for a music playlist video using only each candidate's title and description.
Rank by fit to the given visual mood. Exclude: people/faces, text/logos/posters, maps/diagrams/documents, interiors of named buildings, events/crowds, anything that clashes with the mood, and near-duplicates of an already chosen photo.
Candidates marked pool=true are already downloaded and free to reuse; prefer them when equally fitting.
Respond with JSON only: {"picks": string[]} — candidate ids, best first, at most N.`;
  const user = `Mood: ${mood}\nN = ${count}\nCandidates:\n${candidates.slice(0, 120).map(c => `- id=${c.id} pool=${c.pool ? 'true' : 'false'} | ${c.title} | ${c.desc || ''}`).join('\n')}`;
  const r = await callJson({ cfg, system, user, maxTokens: 2000, cheap: true, call });
  const picks = Array.isArray(r.json?.picks) ? r.json.picks.map(String) : [];
  const valid = new Set(candidates.map(c => String(c.id)));
  return [...new Set(picks.filter(p => valid.has(p)))].slice(0, count);
}

function extractJson(text) {
  const t = String(text || '').replace(/^```(?:json)?\s*|\s*```$/g, '');
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s < 0 || e < 0) return null;
  try { return JSON.parse(t.slice(s, e + 1)); } catch { return null; }
}

export function describeError(e, id) {
  const label = LLM_PROVIDERS[id || e?.provider]?.label || 'LLM';
  if (e?.code === 'NO_KEY') return e.message;
  if (e instanceof Anthropic.AuthenticationError) return 'Claude API 키가 올바르지 않습니다.';
  if (e instanceof Anthropic.RateLimitError) return 'Claude API 사용량 한도에 걸렸습니다. 잠시 후 다시 시도하세요.';
  if (e instanceof Anthropic.NotFoundError) return 'Claude 모델 id 를 찾을 수 없습니다: ' + e.message;
  if (e instanceof Anthropic.BadRequestError) return 'Claude API 요청 오류: ' + e.message;
  if (e instanceof Anthropic.APIError) return `Claude API 오류 ${e.status}: ${e.message}`;
  if (e?.status === 401 || e?.status === 403) return `${label} API 키가 올바르지 않거나 권한이 없습니다. (${e.message})`;
  if (e?.status === 404) return `${label} 모델 id 를 찾을 수 없습니다. 모델 목록에서 고르세요. (${e.message})`;
  if (e?.status === 429) return `${label} 사용량 한도 또는 결제 문제입니다. (${e.message})`;
  return e?.message || String(e);
}
