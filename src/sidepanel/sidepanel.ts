/**
 * Side panel — live transcript view with search, copy, and export.
 */

import { initMessageBus, onMessage } from '../lib/message-bus.js';
import type { TranscriptEntry } from '../lib/types.js';

// ── DOM ─────────────────────────────────────────────────────

const container = document.getElementById('transcriptContainer')!;
const emptyState = document.getElementById('emptyState')!;
const searchInput = document.getElementById('searchInput') as HTMLInputElement;
const entryCount = document.getElementById('entryCount')!;
const copyAllBtn = document.getElementById('copyAllBtn')!;
const exportBtn = document.getElementById('exportBtn')!;

// ── State ───────────────────────────────────────────────────

const entries: TranscriptEntry[] = [];
let autoScroll = true;
let partialEl: HTMLElement | null = null;

// ── Initialize ──────────────────────────────────────────────

function init(): void {
  initMessageBus();

  onMessage('STT_TRANSCRIPT_PARTIAL', ({ text, sequenceId }) => {
    showPartial(text, sequenceId);
  });

  onMessage('STT_TRANSCRIPT_FINAL', ({ text, language, sequenceId }) => {
    clearPartial();
    // Wait for translation to pair
    const entry: TranscriptEntry = {
      sequenceId,
      timestamp: Date.now(),
      originalText: text,
      translatedText: '',
      sourceLanguage: language,
      targetLanguage: '',
      isFinal: false,
      latencyMs: 0,
    };
    entries.push(entry);
    renderEntry(entry);
    updateCount();
  });

  onMessage('TRANSLATION_FINAL', ({ text, sequenceId }) => {
    const entry = entries.find(e => e.sequenceId === sequenceId);
    if (entry) {
      entry.translatedText = text;
      entry.isFinal = true;
      updateEntry(entry);
    }
  });

  onMessage('SESSION_STOP', () => {
    // Offer export
  });

  // Auto-scroll detection
  container.addEventListener('scroll', () => {
    const { scrollTop, scrollHeight, clientHeight } = container;
    autoScroll = scrollHeight - scrollTop - clientHeight < 50;
  });

  // Search
  searchInput.addEventListener('input', () => {
    const query = searchInput.value.toLowerCase();
    const entryEls = container.querySelectorAll('.transcript-entry');
    entryEls.forEach((el) => {
      const text = el.textContent?.toLowerCase() ?? '';
      (el as HTMLElement).style.display = text.includes(query) ? '' : 'none';
    });
  });

  // Copy all
  copyAllBtn.addEventListener('click', () => {
    const text = entries
      .filter(e => e.isFinal)
      .map(e => `[${formatTime(e.timestamp)}]\n  ${e.originalText}\n  → ${e.translatedText}`)
      .join('\n\n');
    navigator.clipboard.writeText(text);
  });

  // Export
  exportBtn.addEventListener('click', () => {
    const text = entries
      .filter(e => e.isFinal)
      .map(e => `[${formatTime(e.timestamp)}] ${e.originalText}\n→ ${e.translatedText}`)
      .join('\n\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `voicebridge-transcript-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

// ── Rendering ───────────────────────────────────────────────

function showPartial(text: string, _sequenceId: number): void {
  emptyState.style.display = 'none';
  if (!partialEl) {
    partialEl = document.createElement('div');
    partialEl.className = 'transcript-entry partial';
    partialEl.innerHTML = `<div class="original">${escapeHtml(text)}</div><div class="translated">...</div>`;
    container.appendChild(partialEl);
  } else {
    const orig = partialEl.querySelector('.original');
    if (orig) orig.textContent = text;
  }
  scrollToBottom();
}

function clearPartial(): void {
  if (partialEl) {
    partialEl.remove();
    partialEl = null;
  }
}

function renderEntry(entry: TranscriptEntry): void {
  emptyState.style.display = 'none';
  const el = document.createElement('div');
  el.className = 'transcript-entry';
  el.dataset['sequenceId'] = String(entry.sequenceId);
  el.innerHTML = `
    <div class="timestamp">${formatTime(entry.timestamp)}</div>
    <div class="original">${escapeHtml(entry.originalText)}</div>
    <div class="translated">${entry.translatedText ? escapeHtml(entry.translatedText) : '<span class="partial">translating...</span>'}</div>
  `;
  container.appendChild(el);
  scrollToBottom();
}

function updateEntry(entry: TranscriptEntry): void {
  const el = container.querySelector(`[data-sequence-id="${entry.sequenceId}"]`);
  if (el) {
    const translated = el.querySelector('.translated');
    if (translated) translated.innerHTML = escapeHtml(entry.translatedText);
  }
}

function updateCount(): void {
  entryCount.textContent = String(entries.length);
}

function scrollToBottom(): void {
  if (autoScroll) {
    container.scrollTop = container.scrollHeight;
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ── Boot ────────────────────────────────────────────────────

init();
