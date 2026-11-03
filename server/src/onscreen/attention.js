// Whether now is a good time to interrupt them, and how. The body (body/Stead.cs) writes state.json
// every second: what's in front (fg.title/url/proc/full), idle ms, notif (SHQueryUserNotificationState)
// and inCall (some app other than her holds the mic right now). From that, one word:
//   test        a quiz or exam: never an unprompted word
//   meeting     a call (Zoom, Teams, Meet, or the mic is live)
//   fullscreen  a game, a video, slides
//   dnd         Windows says not now (quiet hours, presentation mode)
//   away        nobody there (idle 5+ min, or locked)
//   present     at the computer and free
// channel() turns a state and how much it matters into say (now, on screen), hold (later, when they're
// back and free) or phone (text it, for what can't wait). It only ever takes interruptions away.
import fs from 'node:fs';
import path from 'node:path';
// No imports from Stead: the runner loads a copy of this file from ~/.stead/attention.mjs, where
// relative imports point nowhere. Callers pass Stead's folder.

export const TEST = /\b(quiz(zes)?|test|exam|midterm|finals?|assessment|proctor\w*|lockdown|respondus|honorlock|kahoot|quizizz|gimkit|blooket|edpuzzle|testnav|bluebook|examsoft)\b/i;
// Teams' own window says Meeting or Call while one is on; a browser shows it in the address.
export const MEETING_URL = /\bmeet\.google\.com\/[a-z]{3,4}-[a-z]{3,4}-[a-z]{3,4}|teams\.(microsoft|live)\.com\/.*\/l\/meetup|\bzoom\.us\/(wc|j)\/|\bwhereby\.com\/\w|\bwebex\.com\/(meet|join)/i;
const ZOOM = /^(zoom|cpthost)(\.exe)?$/i;
const TEAMS = /^(ms-teams|teams)(\.exe)?$/i;

// SHQueryUserNotificationState: 1 not present (locked, screensaver), 2 busy (full-screen app),
// 3 Direct3D full screen, 4 presentation mode, 5 accepts notifications, 6 quiet time, 7 full-screen store app.
const NOTIF = { 1: 'away', 2: 'fullscreen', 3: 'fullscreen', 4: 'dnd', 6: 'dnd', 7: 'fullscreen' };
export const AWAY_MS = 5 * 60000;

export function state(st = {}, fg = st?.fg || {}) {
  st ||= {}; fg ||= {};
  const all = `${fg.title || ''} ${fg.url || ''}`;
  if (TEST.test(all)) return 'test';
  if (st.inCall === true || ZOOM.test(fg.proc || '') || (TEAMS.test(fg.proc || '') && /\b(meeting|call)\b/i.test(fg.title || '')) || MEETING_URL.test(fg.url || '')) return 'meeting';
  if (fg.full === true) return 'fullscreen';
  const n = NOTIF[Number(st.notif)];
  if (n === 'fullscreen' || n === 'dnd') return n;
  if (n === 'away' || Number(st.idle) >= AWAY_MS) return 'away';
  return 'present';
}

// low: a remark of her own. normal: an offer or a look at an error. high: something due soon.
// urgent: due now, or waiting on their yes. Present hears it all; nothing reaches a test but an urgent
// text; a call or DND gets only what matters, and by phone (a voice or bubble in a call is the worst case).
export const URGENCIES = ['low', 'normal', 'high', 'urgent'];
export const STATES = ['test', 'meeting', 'fullscreen', 'dnd', 'away', 'present'];
const TABLE = {
  present: { low: 'say', normal: 'say', high: 'say', urgent: 'say' },
  test: { low: 'hold', normal: 'hold', high: 'hold', urgent: 'phone' },
  meeting: { low: 'hold', normal: 'hold', high: 'phone', urgent: 'phone' },
  fullscreen: { low: 'hold', normal: 'hold', high: 'hold', urgent: 'phone' },
  dnd: { low: 'hold', normal: 'hold', high: 'hold', urgent: 'phone' },
  away: { low: 'hold', normal: 'hold', high: 'phone', urgent: 'phone' },
};
export function channel(urgency = 'normal', s = 'present') {
  const row = TABLE[s] || TABLE.away;   // an unknown state is treated as nobody there
  return row[urgency] || row.normal;
}

// For other processes (later-tick): the state now, from the body's state.json. 'away' when the body
// isn't up or the file is stale, since then nobody sees her anyway.
export function gateFile(home, now = Date.now()) {
  let st;
  try { st = JSON.parse(fs.readFileSync(path.join(home, 'onscreen', 'state.json'), 'utf8').replace(/^﻿/, '')); } catch { return 'away'; }
  if (!(now - Date.parse(st.at) <= 10000)) return 'away';
  return state(st, st.fg || {});
}
