#!/usr/bin/env node
/**
 * Validate the voicebridge-setup skill and package it for the Agensi marketplace.
 *
 * Checks the Agent Skills rules (https://agentskills.io/specification) plus the
 * upload hygiene Agensi reviews (no .env files, no key-like strings, no binaries),
 * then writes agensi/dist/voicebridge-setup.zip with voicebridge-setup/ at the
 * zip root. Uses the system `zip` on macOS and Linux and PowerShell
 * Compress-Archive on Windows. No npm dependencies.
 *
 * Usage: node agensi/package-skill.mjs
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_NAME = 'voicebridge-setup';
const ROOT = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = join(ROOT, SKILL_NAME);
const DIST_DIR = join(ROOT, 'dist');
const ZIP_PATH = join(DIST_DIR, `${SKILL_NAME}.zip`);

const MAX_NAME_CHARS = 64;
const MAX_DESCRIPTION_CHARS = 1024;
const MAX_COMPATIBILITY_CHARS = 500;
const MAX_SKILL_MD_LINES = 500;
const MAX_FILE_BYTES = 512 * 1024;
const EXCLUDED_NAMES = new Set(['.DS_Store']);
const ALLOWED_FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
const BINARY_EXTENSIONS = /\.(?:exe|dll|so|dylib|bin|o|a|jar|class|pyc|wasm|zip|tar|gz|tgz|7z|rar|dmg|pkg|deb|rpm|msi)$/i;

// SECURITY: patterns for real-looking credentials. Matches are reported by line
// number only, never echoed, so a leaked key does not end up in terminal logs.
const SECRET_PATTERNS = [
  { label: 'sk- style API key (OpenAI, Anthropic, OpenRouter, DashScope)', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { label: 'sk_ style API key (ElevenLabs)', re: /\bsk_[A-Za-z0-9]{24,}/ },
  { label: 'Hugging Face token', re: /\bhf_[A-Za-z0-9]{30,}/ },
  { label: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/ },
  { label: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: 'Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { label: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'hard-coded credential', re: /\b(?:api[_-]?key|secret|token|password)["']?\s*[:=]\s*["'][A-Za-z0-9_\-./+=]{20,}["']/i },
];

const errors = [];
const fail = (message) => errors.push(message);
const chars = (text) => [...text].length;
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** Parse a YAML scalar from the subset skills use. Returns { kind, value }. */
function parseScalar(raw, lineNo) {
  const value = raw.trim();
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) throw new Error(`line ${lineNo}: unterminated double-quoted string`);
    try {
      return { kind: 'string', value: JSON.parse(value) };
    } catch {
      throw new Error(`line ${lineNo}: unsupported escape in double-quoted string`);
    }
  }
  if (value.startsWith("'")) {
    const inner = value.slice(1, -1);
    if (!value.endsWith("'") || value.length < 2 || /(^|[^'])'([^']|$)/.test(inner)) {
      throw new Error(`line ${lineNo}: malformed single-quoted string`);
    }
    return { kind: 'string', value: inner.replace(/''/g, "'") };
  }
  if (/^[[\]{}&*!|>%@`#,]/.test(value) || /^[-?:](\s|$)/.test(value)) {
    throw new Error(`line ${lineNo}: value starts with a YAML indicator; quote it`);
  }
  if (value.includes(': ') || value.includes(' #') || value.endsWith(':')) {
    throw new Error(`line ${lineNo}: plain value contains ": " or " #", which YAML misreads; quote it`);
  }
  const isNumber = /^[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(value) || /^0x[0-9a-f]+$/i.test(value);
  const isOther = /^(?:true|false|yes|no|on|off|null|~)$/i.test(value) || /^[-+]?\.(?:inf|nan)$/i.test(value);
  return { kind: isNumber || isOther ? 'other' : 'string', value };
}

/** Parse frontmatter: top-level `key: value` pairs and one-level nested maps. */
function parseFrontmatter(source) {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0] !== '---') throw new Error('SKILL.md must start with a line containing only ---');
  const close = lines.indexOf('---', 1);
  if (close === -1) throw new Error('frontmatter has no closing --- line');
  const data = {};
  let mapKey = null;
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    if (/^\s*\t/.test(line)) throw new Error(`line ${lineNo}: tabs are not allowed for YAML indentation`);
    const top = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(line);
    const nested = /^ +([A-Za-z0-9_.-]+):\s+(.+)$/.exec(line);
    if (top) {
      const [, key, raw] = top;
      if (key in data) throw new Error(`line ${lineNo}: duplicate field "${key}"`);
      if (raw === undefined || raw.trim() === '') {
        data[key] = { kind: 'map', value: {} };
        mapKey = key;
      } else {
        data[key] = parseScalar(raw, lineNo);
        mapKey = null;
      }
    } else if (nested && mapKey) {
      const [, key, raw] = nested;
      const map = data[mapKey].value;
      if (key in map) throw new Error(`line ${lineNo}: duplicate key "${mapKey}.${key}"`);
      map[key] = parseScalar(raw, lineNo);
    } else {
      throw new Error(`line ${lineNo}: unsupported YAML; keep frontmatter to "key: value" pairs and one nested map`);
    }
  }
  return { data, bodyLines: lines.slice(close + 1) };
}

/** List skill files as '/'-separated relative paths, skipping excluded names. */
function listFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (EXCLUDED_NAMES.has(entry.name)) continue;
      const full = join(dir, entry.name);
      const rel = relative(SKILL_DIR, full).split(sep).join('/');
      if (entry.isSymbolicLink()) fail(`${rel}: symbolic links are not allowed`);
      else if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(rel);
      else fail(`${rel}: not a regular file`);
    }
  };
  walk(SKILL_DIR);
  return files.sort();
}

/** Check one field as a string with optional length limits. */
function checkString(fm, field, { required, max }) {
  const entry = fm[field];
  if (!entry) {
    if (required) fail(`frontmatter: "${field}" is required`);
    return null;
  }
  if (entry.kind !== 'string') {
    fail(`frontmatter: "${field}" must be a string${entry.kind === 'other' ? ' (quote it)' : ''}`);
    return null;
  }
  const length = chars(entry.value);
  if (length === 0) fail(`frontmatter: "${field}" must not be empty`);
  if (max && length > max) fail(`frontmatter: "${field}" is ${length} characters (max ${max})`);
  return entry.value;
}

function validate() {
  const files = listFiles();
  if (!files.includes('SKILL.md')) {
    fail('SKILL.md not found');
    return { files };
  }

  const skillMd = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
  const lineCount = skillMd.split('\n').length - (skillMd.endsWith('\n') ? 1 : 0);
  if (lineCount > MAX_SKILL_MD_LINES) fail(`SKILL.md has ${lineCount} lines (max ${MAX_SKILL_MD_LINES})`);

  let parsed;
  try {
    parsed = parseFrontmatter(skillMd);
  } catch (err) {
    fail(`SKILL.md frontmatter: ${err.message}`);
    return { files, lineCount };
  }
  const fm = parsed.data;
  for (const key of Object.keys(fm)) {
    if (!ALLOWED_FIELDS.has(key)) fail(`frontmatter: unknown field "${key}"`);
  }

  const name = checkString(fm, 'name', { required: true, max: MAX_NAME_CHARS });
  if (name !== null) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      fail('frontmatter: "name" may contain only a-z, 0-9 and single hyphens, and must not start or end with a hyphen');
    }
    if (name !== basename(SKILL_DIR)) fail(`frontmatter: "name" is "${name}" but the folder is "${basename(SKILL_DIR)}"`);
  }
  const description = checkString(fm, 'description', { required: true, max: MAX_DESCRIPTION_CHARS });
  const compatibility = checkString(fm, 'compatibility', { required: false, max: MAX_COMPATIBILITY_CHARS });
  checkString(fm, 'license', { required: false });
  checkString(fm, 'allowed-tools', { required: false });
  if (fm.metadata) {
    if (fm.metadata.kind !== 'map') fail('frontmatter: "metadata" must be a map of string keys to string values');
    else {
      for (const [key, entry] of Object.entries(fm.metadata.value)) {
        if (entry.kind !== 'string') fail(`frontmatter: metadata.${key} must be a string (quote it)`);
      }
    }
  }

  const body = parsed.bodyLines.join('\n');
  if (body.trim() === '') fail('SKILL.md has no body after the frontmatter');
  for (const match of body.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    if (!files.includes(target.replace(/^\.\//, ''))) fail(`SKILL.md links to ${target}, which is not in the skill`);
  }

  for (const rel of files) {
    const fileName = rel.split('/').pop();
    if (fileName === '.env' || fileName.startsWith('.env.')) {
      fail(`${rel}: .env files must not be shipped`);
      continue;
    }
    if (BINARY_EXTENSIONS.test(fileName)) {
      fail(`${rel}: binary files are not allowed`);
      continue;
    }
    const full = join(SKILL_DIR, ...rel.split('/'));
    const size = statSync(full).size;
    if (size > MAX_FILE_BYTES) fail(`${rel}: ${size} bytes (max ${MAX_FILE_BYTES})`);
    const bytes = readFileSync(full);
    let text;
    try {
      if (bytes.includes(0)) throw new Error('NUL byte');
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      fail(`${rel}: not UTF-8 text; binary files are not allowed`);
      continue;
    }
    for (const { label, re } of SECRET_PATTERNS) {
      const found = re.exec(text);
      if (found) fail(`${rel}:${lineOf(text, found.index)}: looks like a ${label}`);
    }
  }
  return { files, lineCount, description, compatibility };
}

/** Read entry names from a zip's central directory (no ZIP64; the skill is small). */
function listZipEntries(zipPath) {
  const buf = readFileSync(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('output is not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('zip central directory is corrupt');
    const nameLength = buf.readUInt16LE(offset + 28);
    names.push(buf.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + buf.readUInt16LE(offset + 30) + buf.readUInt16LE(offset + 32);
  }
  return names;
}

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: ['ignore', 'inherit', 'inherit'], ...options });
  if (result.error) return { ok: false, reason: result.error.message };
  if (result.status !== 0) return { ok: false, reason: `${command} exited with status ${result.status}` };
  return { ok: true };
}

function writeZip() {
  mkdirSync(DIST_DIR, { recursive: true });
  rmSync(ZIP_PATH, { force: true });
  if (process.platform !== 'win32') {
    const result = run('zip', ['-r', '-X', '-q', ZIP_PATH, SKILL_NAME, '-x', '*.DS_Store'], { cwd: ROOT });
    if (!result.ok) throw new Error(`zip failed (${result.reason}); install zip, for example: sudo apt install zip`);
    return;
  }
  // Compress-Archive cannot exclude files, so stage a clean copy inside dist/ first.
  const staging = join(DIST_DIR, '.staging');
  rmSync(staging, { recursive: true, force: true });
  cpSync(SKILL_DIR, join(staging, SKILL_NAME), { recursive: true, filter: (src) => !EXCLUDED_NAMES.has(basename(src)) });
  const quote = (value) => `'${value.replace(/'/g, "''")}'`;
  const command = `$ErrorActionPreference = 'Stop'; Compress-Archive -Path ${quote(join(staging, SKILL_NAME))} -DestinationPath ${quote(ZIP_PATH)} -Force`;
  let result = { ok: false, reason: 'no PowerShell found' };
  for (const shell of ['pwsh', 'powershell']) {
    result = run(shell, ['-NoProfile', '-NonInteractive', '-Command', command], {});
    if (result.ok) break;
  }
  rmSync(staging, { recursive: true, force: true });
  if (!result.ok) throw new Error(`Compress-Archive failed (${result.reason})`);
}

function main() {
  const { files, lineCount, description, compatibility } = validate();
  if (errors.length > 0) {
    rmSync(ZIP_PATH, { force: true });
    console.error(`Validation failed for ${SKILL_NAME}:`);
    for (const message of errors) console.error(`  - ${message}`);
    process.exit(1);
  }
  console.log(
    `Validated ${SKILL_NAME}: ${files.length} files, SKILL.md ${lineCount}/${MAX_SKILL_MD_LINES} lines, ` +
      `description ${chars(description)}/${MAX_DESCRIPTION_CHARS} chars, ` +
      `compatibility ${compatibility === null ? 0 : chars(compatibility)}/${MAX_COMPATIBILITY_CHARS} chars.`,
  );

  writeZip();

  const entries = listZipEntries(ZIP_PATH);
  const badEntries = entries.filter(
    (entry) => entry.includes('\\') || !entry.startsWith(`${SKILL_NAME}/`) || entry.split('/').includes('.DS_Store'),
  );
  const missingEntries = files.filter((file) => !entries.includes(`${SKILL_NAME}/${file}`));
  if (badEntries.length > 0 || missingEntries.length > 0) {
    rmSync(ZIP_PATH, { force: true });
    console.error('The zip layout is wrong, so it was deleted:');
    for (const entry of badEntries) console.error(`  - unexpected entry: ${entry}`);
    for (const file of missingEntries) console.error(`  - missing entry: ${SKILL_NAME}/${file}`);
    if (badEntries.some((entry) => entry.includes('\\'))) {
      console.error('  Windows PowerShell 5.1 writes backslash paths; install PowerShell 7 (pwsh) and run this again.');
    }
    process.exit(1);
  }

  const size = statSync(ZIP_PATH).size;
  console.log(`Wrote ${ZIP_PATH}`);
  console.log(`Size: ${size} bytes (${(size / 1024).toFixed(1)} KB), ${entries.length} entries, root folder ${SKILL_NAME}/`);
}

try {
  main();
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
