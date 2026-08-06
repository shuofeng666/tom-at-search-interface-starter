"use client";

import { CandidateProject, ChatMessage, NeedProfile } from "./types";

const HISTORY_KEY = "tom-search-history-v1";
const SAVED_KEY = "tom-saved-projects-v1";
const MAX_HISTORY_ENTRIES = 15;

export type SearchHistoryEntry = {
  id: string;
  createdAt: number;
  label: string;
  needProfile: NeedProfile;
  messages: ChatMessage[];
  query: string;
  candidates: CandidateProject[];
  pool: CandidateProject[];
  poolCursor: number;
  selectedForComparison: string[];
};

function isBrowser() {
  return typeof window !== "undefined";
}

function readJson<T>(key: string, fallback: T): T {
  if (!isBrowser()) return fallback;

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch (error) {
    console.warn(`Failed to read ${key} from localStorage`, error);
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  if (!isBrowser()) return;

  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn(`Failed to persist ${key} to localStorage`, error);
  }
}

function buildHistoryLabel(needProfile: NeedProfile): string {
  const activity = needProfile.activity?.trim();
  if (activity && activity !== "unknown activity") return activity;
  return "Untitled search";
}

export function loadSearchHistory(): SearchHistoryEntry[] {
  return readJson<SearchHistoryEntry[]>(HISTORY_KEY, []);
}

// One entry per browsing session (see the `sessionId` state in page.tsx).
// Called again every time that session's results change (new search, load
// more, reject) so the stored snapshot always matches what the user last saw
// — re-selecting it from history restores it instantly, no re-search needed.
export function upsertSearchHistory(entry: {
  id: string;
  needProfile: NeedProfile;
  messages: ChatMessage[];
  query: string;
  candidates: CandidateProject[];
  pool: CandidateProject[];
  poolCursor: number;
  selectedForComparison: string[];
}): SearchHistoryEntry[] {
  const existing = loadSearchHistory();
  const previous = existing.find((item) => item.id === entry.id);
  const withoutCurrent = existing.filter((item) => item.id !== entry.id);

  const nextEntry: SearchHistoryEntry = {
    id: entry.id,
    createdAt: previous?.createdAt ?? Date.now(),
    label: buildHistoryLabel(entry.needProfile),
    needProfile: entry.needProfile,
    messages: entry.messages,
    query: entry.query,
    candidates: entry.candidates,
    pool: entry.pool,
    poolCursor: entry.poolCursor,
    selectedForComparison: entry.selectedForComparison
  };

  const next = [nextEntry, ...withoutCurrent].slice(0, MAX_HISTORY_ENTRIES);
  writeJson(HISTORY_KEY, next);
  return next;
}

export function deleteSearchHistoryEntry(id: string): SearchHistoryEntry[] {
  const next = loadSearchHistory().filter((item) => item.id !== id);
  writeJson(HISTORY_KEY, next);
  return next;
}

export function loadSavedProjects(): CandidateProject[] {
  return readJson<CandidateProject[]>(SAVED_KEY, []);
}

// Global, cross-session save list — independent of which search a project
// came from, so it's still there after "New search".
export function saveProjectGlobally(candidate: CandidateProject): CandidateProject[] {
  const existing = loadSavedProjects();
  if (existing.some((item) => item.id === candidate.id)) return existing;

  const next = [candidate, ...existing];
  writeJson(SAVED_KEY, next);
  return next;
}

export function removeSavedProject(id: string): CandidateProject[] {
  const next = loadSavedProjects().filter((item) => item.id !== id);
  writeJson(SAVED_KEY, next);
  return next;
}
