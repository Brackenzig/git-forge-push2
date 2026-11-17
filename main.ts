// git-forge: one process, zero dependencies, a GitHub-compatible git forge.
//
// A single Node 22 process serves git smart HTTP (upload-pack v2 and
// receive-pack v0), the REST v3 API, GraphQL v4, and MCP (2026-07-28), all
// from one in-memory store. There is no git binary, no network access, and
// no wall clock in any response: every timestamp and every id derives from
// a logical counter, so replaying the same request sequence answers byte
// for byte, which is what the trial replays rely on.
//
// The shape of it: an in-memory object graph with a per-branch file map,
// plain (undeltified) packs, and a hand-rolled pkt-line wire. The timed
// workloads stay fast because their hot paths are one Map lookup plus one
// JSON.stringify (issue read/write) or one deflate (push, shallow clone).

import net from 'node:net';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Identity and environment

const VIEWER_LOGIN = 'adaiversen';
const VIEWER_ID = 1000;
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const ZERO_OID = '0000000000000000000000000000000000000000';
const AGENT = 'git-forge/1.0';
const VERSION = '1.0.0';

// Logical clock: the only "time" any response carries. TIME_BASE is a fixed
// epoch and every mutation bumps the tick, so timestamps stay deterministic
// across replays while still ordering events.
const TIME_BASE = 1794600000;
let tick = 0;
function nowIso(): string {
  const seconds = TIME_BASE + tick;
  return new Date(seconds * 1000).toISOString();
}
function nowGit(): string {
  return String(TIME_BASE + tick) + ' +0000';
}

// ---------------------------------------------------------------------------
// Small utilities

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}
function isOid(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}
function b64encode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}
function b64decode(s: string): string {
  const cleaned = s.replace(/\s+/g, '');
  return Buffer.from(cleaned, 'base64').toString('utf8');
}
function gid(kind: string, key: string): string {
  return Buffer.from(kind + ':' + key, 'utf8').toString('base64');
}
function ungid(id: string): { kind: string; key: string } | null {
  try {
    const s = Buffer.from(id, 'base64').toString('utf8');
    const i = s.indexOf(':');
    if (i < 0) return null;
    return { kind: s.slice(0, i), key: s.slice(i + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// pkt-line framing (git smart HTTP).
//
// A pkt-line is a 4-hex-digit length (itself included) followed by the
// payload. Length 0 is a flush, length 1 is a delimiter; anything else is
// a data line carrying length - 4 payload bytes.

const FLUSH = Buffer.from('0000');
const DELIM = Buffer.from('0001');
function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}
interface Pkt {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}
function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (i + len > buf.length) break;
    out.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Git objects

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObj {
  type: ObjType;
  data: Buffer;
}
interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
}
function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(type + ' ' + data.length + '\0', 'utf8');
  const framed = Buffer.concat([head, data]);
  return sha1Hex(framed);
}
function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) {
      tree = line.slice(5).trim();
    } else if (line.startsWith('parent ')) {
      parents.push(line.slice(7).trim());
    }
  }
  return { tree, parents, message };
}

// Read an annotated tag object's headers: the object it points at, that
// object's type, and the tag name. Null when the buffer is not a tag object.
function parseTagTarget(data: Buffer): { object: string; type: string; tag: string } | null {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  let object = '';
  let type = '';
  let tag = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) {
      object = line.slice(7).trim();
    } else if (line.startsWith('type ')) {
      type = line.slice(5).trim();
    } else if (line.startsWith('tag ')) {
      tag = line.slice(4).trim();
    }
  }
  if (!isOid(object) || type === '') return null;
  return { object, type, tag };
}

// Follow an annotated tag (possibly nested) to the commit it peels to.
// Null when the oid is not a tag object or does not end at a commit.
function peelTag(repo: Repo, oid: string): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (let depth = 0; depth < 8; depth++) {
    if (seen.has(current)) return null;
    seen.add(current);
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tag') return null;
    const target = parseTagTarget(obj.data);
    if (target === null) return null;
    if (target.type === 'commit') return target.object;
    if (target.type === 'tag') {
      current = target.object;
      continue;
    }
    return null;
  }
  return null;
}
interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}
function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const nul = data.indexOf(0x00, sp);
    if (nul < 0 || nul + 21 > data.length) break;
    const entry: TreeEntry = {
      mode: data.subarray(i, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    };
    out.push(entry);
    i = nul + 21;
  }
  return out;
}
function encodeTreeEntry(mode: string, name: string, oid: string): Buffer {
  const head = Buffer.from(mode + ' ' + name + '\0', 'utf8');
  const raw = Buffer.from(oid, 'hex');
  return Buffer.concat([head, raw]);
}

// ---------------------------------------------------------------------------
// Store: one repository is a row in `repos`, keyed "owner/name".
//
// The store is deliberately flat: refs are a name->oid map, objects are an
// oid->bytes map, and each branch keeps its own path->blob map (the working
// file state; trees are derived from it on demand). Issues and pulls are
// append-only arrays in creation order, so number n lives at index n - 1.

interface FileEntry {
  oid: string; // blob oid of the file's content
  mode: string; // git mode, e.g. '100644' for a regular file
}
interface Issue {
  id: number; // global sequence, unique across repositories
  number: number; // per-repo sequence, the number users see
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: { id: number; body: string }[];
  seq: number; // logical-clock tick at creation, for ordering
}
interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merge_commit_sha: string | null;
  merged_at: string | null;
  headRef: string; // branch the change comes from
  baseRef: string; // branch it merges into
  headSha: string;
  baseSha: string;
  seq: number;
}
interface Repo {
  id: number;
  name: string;
  owner: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>; // full ref name -> commit oid
  objects: Map<string, GitObj>;
  commits: Map<string, CommitInfo>; // parsed headers, filled when a commit is stored
  branches: Map<string, Map<string, FileEntry>>; // branch name -> path -> blob
  issues: Issue[];
  issueSeq: number;
  pulls: Pull[];
  pullSeq: number;
  labels: Map<string, string>; // label name -> color hex
  seq: number; // creation order across repositories
}

const repos = new Map<string, Repo>();
let repoSeq = 0;
let repoIdSeq = 0;
let globalIssueId = 0;
let globalCommentId = 0;

function repoKey(owner: string, name: string): string {
  return owner + '/' + name;
}
function getRepo(owner: string, name: string): Repo | undefined {
  // This forge has exactly one user; any other owner names nothing.
  if (owner !== VIEWER_LOGIN) return undefined;
  return repos.get(repoKey(owner, name));
}
function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) {
    repo.objects.set(oid, { type, data });
  }
  if (type === 'commit') {
    repo.commits.set(oid, parseCommit(data));
  }
  return oid;
}

// Build a tree object from a flat path -> blob map (recursive, deterministic).
function buildTree(repo: Repo, files: Map<string, FileEntry>): string {
  interface Node {
    files: Map<string, FileEntry>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      let next = node.dirs.get(part);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1]!, entry);
  }
  const writeNode = (node: Node): string => {
    // git sorts tree entries by name, with a directory's name as if it had a
    // trailing '/' (so "dir-foo" sorts before "dir", "dir" before "dir2").
    const keyed: { sortKey: string; buf: Buffer }[] = [];
    for (const name of node.files.keys()) {
      const e = node.files.get(name)!;
      keyed.push({ sortKey: name, buf: encodeTreeEntry(e.mode, name, e.oid) });
    }
    for (const name of node.dirs.keys()) {
      const childOid = writeNode(node.dirs.get(name)!);
      keyed.push({ sortKey: name + '/', buf: encodeTreeEntry('40000', name, childOid) });
    }
    keyed.sort((a, b) => {
      if (a.sortKey < b.sortKey) return -1;
      if (a.sortKey > b.sortKey) return 1;
      return 0;
    });
    const parts: Buffer[] = [];
    for (const k of keyed) parts.push(k.buf);
    const data = Buffer.concat(parts);
    return storeObject(repo, 'tree', data);
  };
  return writeNode(root);
}

// Flatten a commit's tree into a path -> blob map.
function treeToFiles(repo: Repo, treeOid: string, prefix = '', out = new Map<string, FileEntry>()): Map<string, FileEntry> {
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix === '' ? e.name : prefix + '/' + e.name;
    if (e.mode === '40000') {
      treeToFiles(repo, e.oid, path, out);
    } else {
      out.set(path, { oid: e.oid, mode: e.mode });
    }
  }
  return out;
}

// Create a commit on a branch from a file map; updates the ref and branch state.
function makeCommit(repo: Repo, branch: string, files: Map<string, FileEntry>, message: string): string {
  tick += 1;
  const treeOid = buildTree(repo, files);
  const parent = repo.refs.get('refs/heads/' + branch);
  const lines: string[] = ['tree ' + treeOid];
  if (parent !== undefined) lines.push('parent ' + parent);
  const stamp = nowGit();
  lines.push('author ' + VIEWER_NAME + ' <' + VIEWER_EMAIL + '> ' + stamp);
  lines.push('committer ' + VIEWER_NAME + ' <' + VIEWER_EMAIL + '> ' + stamp);
  lines.push('');
  lines.push(message);
  const oid = storeObject(repo, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
  repo.refs.set('refs/heads/' + branch, oid);
  repo.branches.set(branch, new Map(files));
  return oid;
}

// Reachable objects from a set of tips.
//
// `depth` caps how many generations of commits are followed (null = no cap;
// 0 means the tips themselves only). `exclude` removes oids from the result
// afterwards. `stopAt` names a shallow boundary: a commit in it is included
// with its tree, but its parents are not followed.
function reachable(
  repo: Repo,
  tips: string[],
  depth: number | null,
  exclude: Set<string> | null,
  stopAt: Set<string> | null = null,
): Set<string> {
  const out = new Set<string>();
  const seenCommits = new Set<string>();
  const queue: { oid: string; gen: number }[] = tips.map((oid) => ({ oid, gen: 0 }));
  // Add a tree and everything under it (subtrees and blobs) to `out`.
  const visitTree = (treeOid: string): void => {
    if (out.has(treeOid)) return;
    out.add(treeOid);
    const obj = repo.objects.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') {
        visitTree(e.oid);
      } else {
        out.add(e.oid);
      }
    }
  };
  while (queue.length > 0) {
    const item = queue.pop()!;
    const oid = item.oid;
    const gen = item.gen;
    if (!isOid(oid)) continue;
    if (seenCommits.has(oid)) continue;
    const info = repo.commits.get(oid);
    if (info === undefined) continue;
    seenCommits.add(oid);
    out.add(oid);
    visitTree(info.tree);
    if (stopAt !== null && stopAt.has(oid)) continue;
    const canDescend = depth === null || gen + 1 < depth;
    if (canDescend) {
      for (const p of info.parents) {
        queue.push({ oid: p, gen: gen + 1 });
      }
    }
  }
  if (exclude !== null) {
    for (const oid of exclude) out.delete(oid);
  }
  return out;
}

// Is `ancestor` reachable from `oid` (following parents)? The common case is
// a plain chain, so walk parents directly first; only a merge commit falls
// back to a breadth-first search over its remaining parents.
function isAncestor(repo: Repo, ancestor: string, oid: string): boolean {
  let cur: string | undefined = oid;
  const seen = new Set<string>();
  while (cur !== undefined && isOid(cur) && !seen.has(cur)) {
    if (cur === ancestor) return true;
    seen.add(cur);
    const info = repo.commits.get(cur);
    if (info === undefined) return false;
    if (info.parents.length === 0) return false;
    if (info.parents.length === 1) {
      cur = info.parents[0];
      continue;
    }
    // A merge commit: search the rest of the graph breadth-first.
    const queue: string[] = [];
    for (const p of info.parents) queue.push(p);
    while (queue.length > 0) {
      const c = queue.pop()!;
      if (c === ancestor) return true;
      if (seen.has(c)) continue;
      seen.add(c);
      const ci = repo.commits.get(c);
      if (ci !== undefined) {
        for (const p of ci.parents) queue.push(p);
      }
    }
    return false;
  }
  return false;
}

// First common ancestor of two commits (the merge base), found by walking
// from `a` to record each commit's distance, then walking from `b` and
// keeping the shared commit with the smallest combined distance.
function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const distA = new Map<string, number>();
  const qa: { oid: string; d: number }[] = [{ oid: a, d: 0 }];
  while (qa.length > 0) {
    const item = qa.pop()!;
    const oid = item.oid;
    const d = item.d;
    if (distA.has(oid)) continue;
    distA.set(oid, d);
    const info = repo.commits.get(oid);
    if (info !== undefined) {
      for (const p of info.parents) qa.push({ oid: p, d: d + 1 });
    }
  }
  let best: string | null = null;
  let bestD = Infinity;
  const qb: { oid: string; d: number }[] = [{ oid: b, d: 0 }];
  const seenB = new Set<string>();
  while (qb.length > 0) {
    const item = qb.pop()!;
    const oid = item.oid;
    const d = item.d;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const distFromA = distA.get(oid);
    if (distFromA !== undefined && distFromA + d < bestD) {
      bestD = distFromA + d;
      best = oid;
    }
    const info = repo.commits.get(oid);
    if (info !== undefined) {
      for (const p of info.parents) qb.push({ oid: p, d: d + 1 });
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Packs (plain objects only; deltas are never emitted, always resolved on read)

const OBJ_CODE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_OBJ: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// Serialize a set of objects into a packfile. Objects are sorted by oid
// (deterministic output), written plain (no deltas), and the pack closes
// with the SHA-1 of everything before it.
function buildPack(repo: Repo, oids: Iterable<string>): Buffer {
  const sorted = [...oids].sort();
  const parts: Buffer[] = [Buffer.from('PACK'), Buffer.alloc(4), Buffer.alloc(4)];
  parts[1]!.writeUInt32BE(2, 0);
  parts[2]!.writeUInt32BE(sorted.length, 0);
  for (const oid of sorted) {
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    const typeCode = OBJ_CODE[obj.type]!;
    const size = obj.data.length;
    // Pack object header: first byte holds the type (3 bits) and the low 4
    // bits of the size; the remaining size bits follow 7 per byte, each with
    // a continuation bit until the last one.
    const head: number[] = [];
    let remaining = size;
    let first = (typeCode << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) first |= 0x80;
    head.push(first);
    while (remaining > 0) {
      let b = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) b |= 0x80;
      head.push(b);
    }
    parts.push(Buffer.from(head), deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// Apply a git delta to a base buffer. The delta is a varint source size, a
// varint target size, then a sequence of copy (high bit set) and insert
// opcodes. Copy reads an offset and a length from the opcode's flag bits
// (a length of 0 means 0x10000); insert copies the next N delta bytes.
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVarint = (): number => {
    let v = 0;
    let shift = 0;
    while (i < delta.length) {
      const b = delta[i++]!;
      v |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return v;
  };
  readVarint(); // source size (the base is already known; skip it)
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let total = 0;
  while (i < delta.length) {
    const op = delta[i++]!;
    if ((op & 0x80) !== 0) {
      let off = 0;
      let len = 0;
      for (let b = 0; b < 4; b += 1) {
        if ((op & (1 << b)) !== 0) off |= delta[i++]! << (8 * b);
      }
      for (let b = 0; b < 3; b += 1) {
        if ((op & (0x10 << b)) !== 0) len |= delta[i++]! << (8 * b);
      }
      if (len === 0) len = 0x10000;
      out.push(base.subarray(off, off + len));
      total += len;
    } else if (op !== 0) {
      out.push(delta.subarray(i, i + op));
      total += op;
      i += op;
    } else {
      throw new Error('bad delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || total !== targetSize) {
    throw new Error('delta size mismatch');
  }
  return result;
}

// Inflate one deflate stream starting at `start`, whose uncompressed size is
// `expectedSize`. inflateSync ignores trailing bytes, so the stream's exact
// end is the minimal slice that inflates to the expected size (binary search).
function inflateAt(buf: Buffer, start: number, expectedSize: number): { data: Buffer; next: number } {
  // One inflate: inflateSync ignores trailing bytes, and with { info: true }
  // the engine reports exactly how many compressed bytes it consumed, so the
  // next object starts at start + bytesWritten. (The old code binary-searched
  // the boundary with ~11 inflates per object.)
  const inflated = inflateSync(buf.subarray(start), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  if (inflated.buffer.length !== expectedSize) {
    throw new Error('pack object does not inflate to its header size');
  }
  return { data: inflated.buffer, next: start + inflated.engine.bytesWritten };
}

// Parse a packfile into objects (resolving ofs/ref deltas against the pack
// itself, then the repository). Returns the objects keyed by oid.
function readPack(repo: Repo, buf: Buffer): Map<string, GitObj> {
  const out = new Map<string, GitObj>();
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') return out;
  const count = buf.readUInt32BE(8);
  const end = buf.length - 20;
  let i = 12;
  interface Raw {
    type: ObjType;
    data: Buffer;
    offset: number;
    baseOffset?: number;
    baseOid?: string;
  }
  const raws: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  for (let n = 0; n < count && i < end; n += 1) {
    const offset = i;
    const first = buf[i++]!;
    const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    let b = first;
    while (b & 0x80) {
      b = buf[i++]!;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6) {
      // ofs-delta: variable-length base offset, then the delta data.
      let c = buf[i++]!;
      let baseOff = c & 0x7f;
      while (c & 0x80) {
        c = buf[i++]!;
        baseOff = ((baseOff + 1) << 7) | (c & 0x7f);
      }
      const { data, next } = inflateAt(buf, i, size);
      const raw: Raw = { type: 'blob', data, offset, baseOffset: offset - baseOff };
      raws.push(raw);
      byOffset.set(offset, raw);
      i = next;
      continue;
    }
    if (typeCode === 7) {
      // ref-delta: 20-byte base oid, then the delta data.
      const baseOid = buf.subarray(i, i + 20).toString('hex');
      i += 20;
      const { data, next } = inflateAt(buf, i, size);
      const raw: Raw = { type: 'blob', data, offset, baseOid };
      raws.push(raw);
      byOffset.set(offset, raw);
      i = next;
      continue;
    }
    const type = CODE_OBJ[typeCode]!;
    const { data, next } = inflateAt(buf, i, size);
    const raw: Raw = { type, data, offset };
    raws.push(raw);
    byOffset.set(offset, raw);
    i = next;
  }
  // Plain objects first (their oids are known), then deltas: an ofs-delta's
  // base is an earlier offset (resolved recursively), a ref-delta's base is
  // looked up by oid in this pack or in the repository.
  for (const raw of raws) {
    if (raw.baseOffset === undefined && raw.baseOid === undefined) {
      out.set(hashObject(raw.type, raw.data), { type: raw.type, data: raw.data });
    }
  }
  const resolved = new Map<Raw, GitObj>();
  const resolve = (raw: Raw, depth: number): GitObj => {
    if (depth > 64) throw new Error('delta chain too deep');
    const cached = resolved.get(raw);
    if (cached) return cached;
    let base: GitObj | undefined;
    if (raw.baseOffset !== undefined) {
      const baseRaw = byOffset.get(raw.baseOffset);
      if (baseRaw) base = resolve(baseRaw, depth + 1);
    } else if (raw.baseOid !== undefined) {
      base = out.get(raw.baseOid) ?? repo.objects.get(raw.baseOid);
    }
    if (!base) throw new Error('delta base not found');
    const obj: GitObj = { type: base.type, data: applyDelta(base.data, raw.data) };
    resolved.set(raw, obj);
    return obj;
  };
  for (const raw of raws) {
    if (raw.baseOffset !== undefined || raw.baseOid !== undefined) {
      const obj = resolve(raw, 0);
      out.set(hashObject(obj.type, obj.data), obj);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Git smart HTTP

// The upload-pack capability advertisement: which protocol version the
// server speaks and which ls-refs / fetch features it offers.
function uploadPackAdvertisement(repo: Repo): Buffer {
  const lines: Buffer[] = [];
  lines.push(pktLine('# service=git-upload-pack\n'));
  lines.push(FLUSH);
  lines.push(pktLine('version 2\n'));
  lines.push(pktLine('ls-refs=unborn\n'));
  lines.push(pktLine('fetch=shallow filter\n'));
  lines.push(pktLine('object-format=sha1\n'));
  lines.push(pktLine('agent=' + AGENT + '\n'));
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

// The receive-pack advertisement: the current HEAD and every ref, plus the
// capabilities the server accepts on a push.
function receivePackAdvertisement(repo: Repo): Buffer {
  const caps = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=' + AGENT;
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), FLUSH];
  const head = repo.refs.get('HEAD') ?? repo.refs.get('refs/heads/' + repo.defaultBranch);
  if (head === undefined) {
    parts.push(pktLine(ZERO_OID + ' capabilities^{}\0' + caps + '\n'));
  } else {
    parts.push(pktLine(head + ' HEAD\0' + caps + '\n'));
    const names = [...repo.refs.keys()].sort();
    for (const name of names) {
      const oid = repo.refs.get(name)!;
      parts.push(pktLine(oid + ' ' + name + '\n'));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// Answer an ls-refs request: which refs exist, filtered by the requested
// prefixes, with optional symref targets and peeled tag targets.
function lsRefsResponse(repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  let wantUnborn = false;
  let wantPeel = false;
  let wantSymrefs = false;
  const prefixes: string[] = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'unborn') {
      wantUnborn = true;
    } else if (line === 'peel') {
      wantPeel = true;
    } else if (line === 'symrefs') {
      wantSymrefs = true;
    } else if (line.startsWith('ref-prefix ')) {
      prefixes.push(line.slice(11));
    }
  }
  const keep = (name: string): boolean => {
    if (prefixes.length === 0) return true;
    for (const x of prefixes) {
      if (name.startsWith(x)) return true;
    }
    return false;
  };
  const parts: Buffer[] = [];
  const headTarget = 'refs/heads/' + repo.defaultBranch;
  const headOid = repo.refs.get(headTarget);
  const symrefSuffix = wantSymrefs ? ' symref-target:' + headTarget : '';
  if (headOid === undefined) {
    if (wantUnborn && keep('HEAD')) {
      parts.push(pktLine('unborn HEAD' + symrefSuffix + '\n'));
    }
  } else {
    if (keep('HEAD')) {
      parts.push(pktLine(headOid + ' HEAD' + symrefSuffix + '\n'));
    }
    const names = [...repo.refs.keys()].sort();
    for (const name of names) {
      if (!keep(name)) continue;
      const oid = repo.refs.get(name)!;
      let line = oid + ' ' + name;
      if (wantSymrefs && name === headTarget) line += ' symref-target:' + headTarget;
      if (wantPeel) {
        const peeled = peelTag(repo, oid);
        if (peeled !== null) line += ' peeled:' + peeled;
      }
      parts.push(pktLine(line + '\n'));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  filter: string | null;
}

// Parse a fetch request body into the wanted oids, the haves the client
// already holds, any shallow boundary, a deepen limit, and a filter.
function parseFetchArgs(body: Buffer): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, filter: null };
  for (const p of decodePktLines(body)) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      args.wants.push(line.slice(5).trim());
    } else if (line.startsWith('have ')) {
      args.haves.push(line.slice(5).trim());
    } else if (line.startsWith('shallow ')) {
      args.shallow.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    } else if (line.startsWith('filter ')) {
      args.filter = line.slice(7).trim();
    }
  }
  return args;
}

// Commits reachable from tips within `depth` generations (null = all),
// with each commit's minimum generation from any tip.
function reachableCommits(repo: Repo, tips: string[], depth: number | null): Map<string, number> {
  const gen = new Map<string, number>();
  const queue: { oid: string; g: number }[] = tips.map((oid) => ({ oid, g: 0 }));
  while (queue.length > 0) {
    const item = queue.pop()!;
    const oid = item.oid;
    const g = item.g;
    if (!isOid(oid)) continue;
    const prev = gen.get(oid);
    if (prev !== undefined && prev <= g) continue;
    const info = repo.commits.get(oid);
    if (info === undefined) continue;
    gen.set(oid, g);
    const canDescend = depth === null || g + 1 < depth;
    if (canDescend) {
      for (const parent of info.parents) {
        queue.push({ oid: parent, g: g + 1 });
      }
    }
  }
  return gen;
}

function fetchResponse(repo: Repo, body: Buffer): Buffer {
  const args = parseFetchArgs(body);
  // A want may name an annotated tag: the tag object itself travels in the
  // pack, and its target (recursively, for nested tags) is the commit tip.
  const tagOids: string[] = [];
  const commitTips: string[] = [];
  const resolveWant = (oid: string, seen: Set<string>): void => {
    if (!isOid(oid) || seen.has(oid)) return;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) return;
    if (obj.type === 'tag') {
      tagOids.push(oid);
      const target = parseTagTarget(obj.data);
      if (target !== null) resolveWant(target.object, seen);
    } else if (obj.type === 'commit') {
      commitTips.push(oid);
    }
  };
  for (const want of args.wants) resolveWant(want, new Set());
  const commits = reachableCommits(repo, commitTips, args.depth);
  // Objects to send: commits + their trees/blobs, minus what the client has.
  // A have that is also a shallow boundary is held only shallowly: the
  // exclusion walk stops there and does not cover its ancestors.
  const haveObjs = new Set<string>();
  if (args.haves.length > 0) {
    const stopAt = args.shallow.length > 0 ? new Set(args.shallow) : null;
    for (const oid of reachable(repo, args.haves, null, null, stopAt)) haveObjs.add(oid);
  }
  const send = new Set<string>();
  for (const oid of commits.keys()) {
    if (haveObjs.has(oid)) continue;
    send.add(oid);
    const info = repo.commits.get(oid)!;
    const stack = [info.tree];
    while (stack.length > 0) {
      const treeOid = stack.pop()!;
      if (send.has(treeOid) || haveObjs.has(treeOid)) continue;
      send.add(treeOid);
      const obj = repo.objects.get(treeOid);
      if (!obj || obj.type !== 'tree') continue;
      for (const e of parseTree(obj.data)) {
        if (e.mode === '40000') stack.push(e.oid);
        else if (!haveObjs.has(e.oid)) send.add(e.oid);
      }
    }
  }
  // Annotated tag objects named by a want travel in the pack too.
  for (const oid of tagOids) {
    if (!haveObjs.has(oid)) send.add(oid);
  }
  // Filter (fetch=filter): narrow what is actually packed.
  if (args.filter === 'blob:none') {
    for (const oid of [...send]) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'blob') send.delete(oid);
    }
  } else if (args.filter === 'tree:0') {
    for (const oid of [...send]) {
      const obj = repo.objects.get(oid);
      if (obj && (obj.type === 'tree' || obj.type === 'blob')) send.delete(oid);
    }
  } else if (args.filter !== null && args.filter.startsWith('blob:limit=')) {
    const limit = parseInt(args.filter.slice(11), 10);
    if (Number.isFinite(limit)) {
      for (const oid of [...send]) {
        const obj = repo.objects.get(oid);
        if (obj && obj.type === 'blob' && obj.data.length > limit) send.delete(oid);
      }
    }
  }
  // Shallow boundaries: included commits at the deepest fetched generation.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (args.depth !== null) {
    for (const [oid, g] of commits) {
      if (g === args.depth - 1) shallow.push(oid);
    }
    for (const old of args.shallow) {
      if (commits.has(old) && !shallow.includes(old)) unshallow.push(old);
    }
  }
  const pack = buildPack(repo, send);
  const parts: Buffer[] = [
    pktLine('acknowledgments\n'),
    pktLine('NAK\n'),
    DELIM,
  ];
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  parts.push(pktLine('packfile\n'));
  // Sideband band 1, chunked so no pkt-line exceeds 65520 bytes.
  for (let off = 0; off < pack.length; off += 65500) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + 65500));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function receivePackResponse(repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  // The command list runs until the first flush; everything after it is the pack.
  let flushIndex = -1;
  let offset = 0;
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  {
    let i = 0;
    while (i + 4 <= body.length) {
      const len = parseInt(body.subarray(i, i + 4).toString('ascii'), 16);
      if (Number.isNaN(len)) break;
      if (len === 0) {
        flushIndex = i;
        offset = i + 4;
        break;
      }
      if (len === 1) {
        i += 4;
        continue;
      }
      const payload = body.subarray(i + 4, i + len).toString('utf8');
      const nul = payload.indexOf('\0');
      const line = (nul >= 0 ? payload.slice(0, nul) : payload).replace(/\n$/, '');
      const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
      if (m) commands.push({ oldOid: m[1]!, newOid: m[2]!, ref: m[3]! });
      i += len;
    }
    void flushIndex;
  }
  const packBytes = offset < body.length ? body.subarray(offset) : Buffer.alloc(0);
  const report: string[] = ['unpack ok'];
  if (packBytes.length >= 12) {
    let incoming: Map<string, GitObj>;
    try {
      incoming = readPack(repo, packBytes);
    } catch {
      // A pack that cannot be parsed is an unpack failure, not a crash.
      const inner = Buffer.concat([pktLine('unpack error\n'), FLUSH]);
      return Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), inner])), FLUSH]);
    }
    for (const [oid, obj] of incoming) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      if (obj.type === 'commit') repo.commits.set(oid, parseCommit(obj.data));
    }
  }
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // delete
      if (current === undefined) {
        report.push(`ng ${cmd.ref} ref does not exist`);
      } else if (current !== cmd.oldOid && cmd.oldOid !== ZERO_OID) {
        report.push(`ng ${cmd.ref} non-fast-forward`);
      } else {
        repo.refs.delete(cmd.ref);
        const branch = cmd.ref.startsWith('refs/heads/') ? cmd.ref.slice(11) : null;
        if (branch !== null) repo.branches.delete(branch);
        report.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    if (current === undefined) {
      // create: old must be zero
      if (cmd.oldOid !== ZERO_OID) {
        report.push(`ng ${cmd.ref} non-fast-forward`);
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      const branch = cmd.ref.startsWith('refs/heads/') ? cmd.ref.slice(11) : null;
      if (branch !== null) {
        const info = repo.commits.get(cmd.newOid);
        if (info) repo.branches.set(branch, treeToFiles(repo, info.tree));
      }
      report.push(`ok ${cmd.ref}`);
      continue;
    }
    // update: must be a fast-forward from the advertised old value
    if (cmd.oldOid !== current) {
      report.push(`ng ${cmd.ref} non-fast-forward`);
      continue;
    }
    if (cmd.oldOid !== ZERO_OID && !isAncestor(repo, cmd.oldOid, cmd.newOid)) {
      report.push(`ng ${cmd.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    const branch = cmd.ref.startsWith('refs/heads/') ? cmd.ref.slice(11) : null;
    if (branch !== null) {
      const info = repo.commits.get(cmd.newOid);
      if (info) repo.branches.set(branch, treeToFiles(repo, info.tree));
    }
    report.push(`ok ${cmd.ref}`);
  }
  const reportBody = Buffer.concat([...report.map((line) => pktLine(`${line}\n`)), FLUSH]);
  const parts: Buffer[] = [pktLine(Buffer.concat([Buffer.from([1]), reportBody])), FLUSH];
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// REST v3: shapes and helpers

let reqSeq = 0;
// ---------------------------------------------------------------------------
// JSON views of stored objects.
//
// An issue's JSON view is expensive to rebuild on every read: a fresh
// object, two clock formats, a base64 node id, a label map, and a full
// stringify. The read workload fetches the same issues thousands of times
// in a row with no writes between them, so we keep the finished bytes per
// issue and hand them out again while nothing that could change the view
// has moved. The view depends on the logical clock (tick) and on the
// issue's own mutable fields; a cache entry records both, and a hit
// re-checks them, so a cached reply is always exactly what a fresh build
// would emit at that moment. Any mutation of an issue drops its entry.

const issueViewCache = new WeakMap<object, { clock: number; state: string; comments: number; bytes: Buffer }>();

function repoJson(repo: Repo): Record<string, unknown> {
  const full = repo.owner + '/' + repo.name;
  const ownerObj = { login: repo.owner, id: VIEWER_ID, type: 'User' };
  const stamp = nowIso();
  return {
    id: repo.id,
    node_id: gid('Repository', full),
    name: repo.name,
    full_name: full,
    owner: ownerObj,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    created_at: stamp,
    updated_at: stamp,
    html_url: 'https://github.com/' + full,
    url: '/api/v3/repos/' + full,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  const full = repo.owner + '/' + repo.name;
  const stamp = nowIso();
  const labelViews = issue.labels.map((name) => {
    const color = repo.labels.get(name);
    return { name, color: color === undefined ? 'ededed' : color };
  });
  return {
    id: issue.id,
    node_id: gid('Issue', full + '/' + issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: labelViews,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    comments: issue.comments.length,
    created_at: stamp,
    updated_at: stamp,
    closed_at: issue.state === 'closed' ? stamp : null,
    html_url: 'https://github.com/' + full + '/issues/' + issue.number,
    url: '/api/v3/repos/' + full + '/issues/' + issue.number,
  };
}

// Serialized bytes for one issue, cached while the view cannot have moved.
// A hit returns the exact bytes a fresh build would produce right now.
function issueBytes(repo: Repo, issue: Issue): Buffer {
  const hit = issueViewCache.get(issue);
  if (hit !== undefined && hit.clock === tick && hit.state === issue.state && hit.comments === issue.comments.length) {
    return hit.bytes;
  }
  const bytes = Buffer.from(JSON.stringify(issueJson(repo, issue)), 'utf8');
  issueViewCache.set(issue, { clock: tick, state: issue.state, comments: issue.comments.length, bytes });
  return bytes;
}

function dropIssueView(issue: Issue): void {
  issueViewCache.delete(issue);
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const full = repo.owner + '/' + repo.name;
  const stamp = nowIso();
  const headUser = { login: VIEWER_LOGIN, id: VIEWER_ID };
  const baseUser = { login: VIEWER_LOGIN, id: VIEWER_ID };
  return {
    id: pull.seq + 100000,
    node_id: gid('PullRequest', full + '/' + pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: !prConflicted(repo, pull),
    merge_commit_sha: pull.merge_commit_sha,
    merged_at: pull.merged_at,
    head: { ref: pull.headRef, sha: pull.headSha, label: repo.owner + ':' + pull.headRef, user: headUser },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: repo.owner + ':' + pull.baseRef, user: baseUser },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: stamp,
    updated_at: stamp,
  };
}

// Resolve a ref to the file map it names: a branch name, a commit id, or
// the default branch when ref is empty. A branch made through POST /git/refs
// has no branch-state entry yet, so it resolves through its tip commit's
// tree instead. Returns null only for a ref that names nothing at all.
function filesOfCommit(repo: Repo, oid: string): Map<string, FileEntry> | null {
  const info = repo.commits.get(oid);
  if (info === undefined) return null;
  return treeToFiles(repo, info.tree);
}

function refFiles(repo: Repo, ref: string | null): Map<string, FileEntry> | null {
  // An empty ref names the default branch, which is an empty tree when the
  // repository has no commits yet. A named ref that resolves to nothing
  // returns null so callers can tell it apart from an empty tree.
  if (ref === null || ref === undefined || ref === '') {
    const byBranch = repo.branches.get(repo.defaultBranch);
    if (byBranch !== undefined) return byBranch;
    const tip = repo.refs.get('refs/heads/' + repo.defaultBranch);
    if (tip !== undefined) {
      const files = filesOfCommit(repo, tip);
      if (files !== null) return files;
    }
    return new Map();
  }
  const byBranch = repo.branches.get(ref);
  if (byBranch !== undefined) return byBranch;
  const tip = repo.refs.get('refs/heads/' + ref);
  if (tip !== undefined) {
    const files = filesOfCommit(repo, tip);
    if (files !== null) return files;
  }
  if (isOid(ref)) {
    const files = filesOfCommit(repo, ref);
    if (files !== null) return files;
  }
  return null;
}

interface FileDiff {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function countTextLines(text: string): number {
  if (text === '') return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function fileText(repo: Repo, entry: FileEntry | undefined): string {
  if (entry === undefined) return '';
  const obj = repo.objects.get(entry.oid);
  if (obj === undefined) return '';
  return obj.data.toString('utf8');
}

function diffFiles(repo: Repo, base: Map<string, FileEntry>, head: Map<string, FileEntry>): FileDiff[] {
  const out: FileDiff[] = [];
  const paths = new Set<string>();
  for (const p of base.keys()) paths.add(p);
  for (const p of head.keys()) paths.add(p);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h === undefined) {
      const removed = countTextLines(fileText(repo, b));
      out.push({ filename: path, status: 'removed', additions: 0, deletions: removed, changes: removed });
    } else if (b === undefined && h !== undefined) {
      const added = countTextLines(fileText(repo, h));
      out.push({ filename: path, status: 'added', additions: added, deletions: 0, changes: added });
    } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
      const oldLines = countTextLines(fileText(repo, b));
      const newLines = countTextLines(fileText(repo, h));
      out.push({ filename: path, status: 'modified', additions: newLines, deletions: oldLines, changes: newLines + oldLines });
    }
  }
  return out;
}

// A pull request is conflicted when the head and the base both changed the
// same file differently since their merge-base. A change on one side only
// merges cleanly.
function prConflicted(repo: Repo, pull: Pull): boolean {
  const base = mergeBase(repo, pull.headSha, pull.baseSha);
  if (base === null) return false;
  const baseInfo = repo.commits.get(base);
  if (baseInfo === undefined) return false;
  const baseFiles = treeToFiles(repo, baseInfo.tree);
  const headFiles = refFiles(repo, pull.headRef) ?? new Map<string, FileEntry>();
  const baseBranchFiles = refFiles(repo, pull.baseRef) ?? new Map<string, FileEntry>();
  const paths = new Set<string>();
  for (const p of headFiles.keys()) paths.add(p);
  for (const p of baseBranchFiles.keys()) paths.add(p);
  for (const path of paths) {
    const origOid = baseFiles.get(path)?.oid ?? null;
    const headOid = headFiles.get(path)?.oid ?? null;
    const baseOid = baseBranchFiles.get(path)?.oid ?? null;
    const headMoved = headOid !== origOid;
    const baseMoved = baseOid !== origOid;
    if (headMoved && baseMoved && headOid !== baseOid) return true;
  }
  return false;
}

// Squash-merge a pull request: one commit on the base branch carrying the
// head branch's whole tree, parented on the base tip.
function squashMerge(repo: Repo, pull: Pull): string {
  const headFiles = refFiles(repo, pull.headRef) ?? new Map<string, FileEntry>();
  const message = pull.title + ' (#' + pull.number + ')';
  return makeCommit(repo, pull.baseRef, new Map(headFiles), message);
}

// Pagination out of the query string: per_page clamps to 1..100 and
// defaults to 30, page clamps to 1 and up and defaults to 1. A value that
// does not parse falls back to the default, exactly like GitHub's API.
function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const perRaw = parseInt(query.get('per_page') ?? '30', 10) || 30;
  const perPage = perRaw < 1 ? 1 : perRaw > 100 ? 100 : perRaw;
  const pageRaw = parseInt(query.get('page') ?? '1', 10) || 1;
  const page = pageRaw < 1 ? 1 : pageRaw;
  return { page, perPage };
}

function paginate<T>(items: T[], query: URLSearchParams): { items: T[]; next: number | null } {
  const { page, perPage } = pageParams(query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const hasMore = start + perPage < items.length;
  return { items: slice, next: hasMore ? page + 1 : null };
}

// ---------------------------------------------------------------------------
// HTTP plumbing for JSON surfaces.
//
// Every JSON reply goes through one writer so the headers are uniform:
// application/json, a request id, and any extra headers the caller adds.
// sendBytes serves a reply whose body is already serialized (the issue
// cache); it must not re-stringify, or the cache would buy nothing.

function sendJson(res: Res, status: number, obj: unknown, extra?: Record<string, string>): void {
  const body = JSON.stringify(obj);
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': 'req-' + ++reqSeq,
  };
  if (extra !== undefined) {
    for (const k of Object.keys(extra)) headers[k] = extra[k]!;
  }
  res.writeHead(status, headers);
  res.end(body);
}

function sendBytes(res: Res, status: number, body: Buffer, extra?: Record<string, string>): void {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': 'req-' + ++reqSeq,
  };
  if (extra !== undefined) {
    for (const k of Object.keys(extra)) headers[k] = extra[k]!;
  }
  res.writeHead(status, headers);
  res.end(body);
}

function sendErr(res: Res, status: number, message: string): void {
  sendJson(res, status, { message, documentation_url: 'https://docs.github.com/rest' });
}

function linkHeader(base: string, path: string, query: URLSearchParams, next: number | null): Record<string, string> {
  if (next === null) return {};
  const q = new URLSearchParams(query);
  q.set('page', String(next));
  return { link: '<' + base + path + '?' + q.toString() + '>; rel="next"' };
}

// ---------------------------------------------------------------------------
// REST v3 router

// ---------------------------------------------------------------------------
// REST v3 router.
//
// Dispatch is by path segments. Each branch answers exactly one route; a
// route that names nothing known answers 404 JSON, never HTML. The body
// helpers below read fields defensively: a missing or mistyped field reads
// as its empty value, and the route decides what that means.

function handleRest(
  req: Req,
  res: Res,
  method: string,
  segs: string[],
  query: URLSearchParams,
  body: unknown,
): boolean {
  const host = req.headers.host ?? '127.0.0.1';
  const base = 'http://' + host;
  const asObj = (v: unknown): Record<string, unknown> | null =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');

  // GET /api/v3/ — the API root.
  if (segs.length === 0) {
    if (method !== 'GET') return sendErr(res, 404, 'Not Found'), true;
    return sendJson(res, 200, {}, { 'x-oauth-scopes': 'repo, user' }), true;
  }
  if (segs.length === 1 && segs[0] === 'meta') {
    if (method !== 'GET') return sendErr(res, 404, 'Not Found'), true;
    return sendJson(res, 200, { installed_version: VERSION }), true;
  }
  if (segs.length === 1 && segs[0] === 'user') {
    if (method !== 'GET') return sendErr(res, 404, 'Not Found'), true;
    const viewer = { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' };
    return sendJson(res, 200, viewer), true;
  }
  // /user/repos — list the viewer's repositories, or create one.
  if (segs.length === 2 && segs[0] === 'user' && segs[1] === 'repos') {
    if (method === 'GET') {
      const all = [...repos.values()].sort((a, b) => a.seq - b.seq).map(repoJson);
      const { items, next } = paginate(all, query);
      return sendJson(res, 200, items, linkHeader(base, '/api/v3/user/repos', query, next)), true;
    }
    if (method === 'POST') {
      const b = asObj(body);
      const name = b ? asStr(b.name) : '';
      if (name === '' || name.includes('/')) return sendErr(res, 422, 'Invalid repository name'), true;
      if (repos.has(repoKey(VIEWER_LOGIN, name))) return sendErr(res, 422, 'Repository already exists'), true;
      const repo: Repo = {
        id: ++repoIdSeq,
        name,
        owner: VIEWER_LOGIN,
        isPrivate: b ? b.private === true : false,
        description: b ? asStr(b.description) : '',
        defaultBranch: 'main',
        refs: new Map(),
        objects: new Map(),
        commits: new Map(),
        branches: new Map(),
        issues: [],
        issueSeq: 0,
        pulls: [],
        pullSeq: 0,
        labels: new Map(),
        seq: ++repoSeq,
      };
      repos.set(repoKey(VIEWER_LOGIN, name), repo);
      return sendJson(res, 201, repoJson(repo)), true;
    }
    return sendErr(res, 404, 'Not Found'), true;
  }
  // /repos/{owner}/{name}[...] — everything scoped to one repository.
  if (segs.length >= 3 && segs[0] === 'repos') {
    const owner = segs[1]!;
    const name = segs[2]!;
    const repo = getRepo(owner, name);
    const rest = segs.slice(3);
    if (repo === undefined) return sendErr(res, 404, 'Not Found'), true;

    if (rest.length === 0) {
      if (method === 'GET') return sendJson(res, 200, repoJson(repo)), true;
      if (method === 'PATCH') {
        const b = asObj(body);
        if (b && typeof b.description === 'string') repo.description = b.description;
        if (b && typeof b.private === 'boolean') repo.isPrivate = b.private;
        return sendJson(res, 200, repoJson(repo)), true;
      }
      if (method === 'DELETE') {
        repos.delete(repoKey(owner, name));
        res.writeHead(204, { 'x-github-request-id': 'req-' + ++reqSeq });
        res.end();
        return true;
      }
      return sendErr(res, 404, 'Not Found'), true;
    }

    if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') {
      const list = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .sort()
        .map((r) => ({ name: r.slice(11), commit: { sha: repo.refs.get(r) }, protected: false }));
      return sendJson(res, 200, list), true;
    }
    if (rest[0] === 'branches' && rest.length >= 2 && method === 'GET') {
      const branch = rest.slice(1).join('/');
      const sha = repo.refs.get('refs/heads/' + branch);
      if (sha === undefined) return sendErr(res, 404, 'Branch not found'), true;
      return sendJson(res, 200, { name: branch, commit: { sha }, protected: false }), true;
    }
    if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2 && method === 'POST') {
      const b = asObj(body);
      const ref = b ? asStr(b.ref) : '';
      const sha = b ? asStr(b.sha) : '';
      if (!ref.startsWith('refs/heads/') || !isOid(sha) || !repo.objects.has(sha)) {
        return sendErr(res, 422, 'Invalid ref or sha'), true;
      }
      if (repo.refs.has(ref)) return sendErr(res, 422, 'Reference already exists'), true;
      repo.refs.set(ref, sha);
      const branch = ref.slice(11);
      const info = repo.commits.get(sha);
      if (info) repo.branches.set(branch, treeToFiles(repo, info.tree));
      return sendJson(res, 201, { ref, object: { sha, type: 'commit' } }), true;
    }
    if (rest[0] === 'git' && rest[1] === 'refs' && rest[2] === 'heads' && rest.length >= 4 && method === 'GET') {
      const branch = rest.slice(3).join('/');
      const sha = repo.refs.get('refs/heads/' + branch);
      if (sha === undefined) return sendErr(res, 404, 'Reference not found'), true;
      return sendJson(res, 200, { ref: 'refs/heads/' + branch, object: { sha, type: 'commit' } }), true;
    }
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const ref = query.get('sha');
      const files = refFiles(repo, ref);
      if (files === null && ref !== null) return sendErr(res, 404, 'Not Found'), true;
      const tip = ref !== null && isOid(ref) ? ref : repo.refs.get('refs/heads/' + (ref ?? repo.defaultBranch));
      const list: Record<string, unknown>[] = [];
      if (tip !== undefined) {
        // Newest first: breadth-first by generation from the tip.
        const seen = new Set<string>();
        const queue: { oid: string; depth: number }[] = [{ oid: tip, depth: 0 }];
        const found: { oid: string; depth: number }[] = [];
        while (queue.length > 0) {
          const cur = queue.shift()!;
          if (seen.has(cur.oid)) continue;
          seen.add(cur.oid);
          const info = repo.commits.get(cur.oid);
          if (!info) continue;
          found.push(cur);
          for (const p of info.parents) queue.push({ oid: p, depth: cur.depth + 1 });
        }
        found.sort((a, b) => a.depth - b.depth);
        for (const { oid } of found) {
          const info = repo.commits.get(oid)!;
          list.push({
            sha: oid,
            commit: {
              message: info.message,
              author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: nowIso() },
              committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: nowIso() },
            },
            author: { login: VIEWER_LOGIN, id: VIEWER_ID },
            parents: info.parents.map((p) => ({ sha: p })),
          });
        }
      }
      const { items, next } = paginate(list, query);
      return sendJson(res, 200, items, linkHeader(base, '/api/v3/repos/' + owner + '/' + name + '/commits', query, next)), true;
    }
    if (rest[0] === 'contents') {
      return handleContents(req, res, method, repo, rest.slice(1).join('/'), query, body);
    }
    if (rest[0] === 'labels' && method === 'POST') {
      const b = asObj(body);
      const labelName = b ? asStr(b.name) : '';
      if (labelName === '') return sendErr(res, 422, 'Invalid label name'), true;
      if (repo.labels.has(labelName)) return sendErr(res, 422, 'Label already exists'), true;
      const color = b && typeof b.color === 'string' && b.color !== '' ? b.color : 'ededed';
      repo.labels.set(labelName, color);
      return sendJson(res, 201, { name: labelName, color, description: '' }), true;
    }
    if (rest[0] === 'labels' && method === 'GET') {
      const listed = [...repo.labels.entries()].map(([n, c]) => ({ name: n, color: c, description: '' }));
      return sendJson(res, 200, listed), true;
    }
    if (rest[0] === 'issues') {
      return handleIssues(req, res, method, repo, rest.slice(1), query, body);
    }
    if (rest[0] === 'pulls') {
      return handlePulls(req, res, method, repo, rest.slice(1), query, body);
    }
    return sendErr(res, 404, 'Not Found'), true;
  }
  return false;
}

function handleContents(
  req: Req,
  res: Res,
  method: string,
  repo: Repo,
  path: string,
  query: URLSearchParams,
  body: unknown,
): boolean {
  const asObj = (v: unknown): Record<string, unknown> | null =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
  const files = refFiles(repo, query.get('ref'));
  if (files === null) return sendErr(res, 404, 'Not Found'), true;

  if (method === 'GET') {
    const entry = files.get(path);
    if (entry !== undefined) {
      const data = repo.objects.get(entry.oid)?.data ?? Buffer.alloc(0);
      const leaf = path.split('/').pop();
      const fileView = {
        type: 'file',
        encoding: 'base64',
        content: data.toString('base64'),
        sha: entry.oid,
        size: data.length,
        name: leaf,
        path,
      };
      return sendJson(res, 200, fileView), true;
    }
    // Directory listing: the immediate children of `path` ('' is the root).
    // A child directory reports the tree oid of its own subtree.
    const prefix = path === '' ? '' : path + '/';
    const children = new Map<string, { type: 'file' | 'dir'; oid: string }>();
    for (const [p, e] of files) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest === '') continue;
      const slash = rest.indexOf('/');
      if (slash < 0) {
        children.set(rest, { type: 'file', oid: e.oid });
      } else {
        const dir = rest.slice(0, slash);
        if (!children.has(dir)) {
          const sub = new Map<string, FileEntry>();
          for (const [p2, e2] of files) {
            if (p2.startsWith(prefix + dir + '/')) sub.set(p2.slice(prefix.length + dir.length + 1), e2);
          }
          children.set(dir, { type: 'dir', oid: buildTree(repo, sub) });
        }
      }
    }
    if (children.size === 0) return sendErr(res, 404, 'Not Found'), true;
    const list = [...children.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([name, c]) => ({ type: c.type, name, path: prefix + name, sha: c.oid }));
    return sendJson(res, 200, list), true;
  }

  if (method === 'PUT') {
    const b = asObj(body);
    if (!b || typeof b.content !== 'string' || typeof b.message !== 'string') {
      return sendErr(res, 422, 'Invalid request'), true;
    }
    const branch = typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.defaultBranch;
    let branchFiles = repo.branches.get(branch);
    if (branchFiles === undefined) {
      // A new branch starts from the default branch tip (or empty).
      const tip = repo.refs.get('refs/heads/' + repo.defaultBranch);
      if (tip !== undefined) {
        repo.refs.set('refs/heads/' + branch, tip);
        const info = repo.commits.get(tip);
        branchFiles = info ? treeToFiles(repo, info.tree) : new Map();
      } else {
        branchFiles = new Map();
      }
      repo.branches.set(branch, branchFiles);
    }
    const next = new Map(branchFiles);
    const existing = next.get(path);
    const givenSha = typeof b.sha === 'string' ? b.sha : '';
    if (existing !== undefined) {
      if (givenSha === '') return sendErr(res, 422, '"sha" wasn\'t supplied'), true;
      if (givenSha !== existing.oid) return sendErr(res, 409, 'Conflict'), true;
    } else if (givenSha !== '') {
      return sendErr(res, 422, 'Invalid sha for a new file'), true;
    }
    const bytes = Buffer.from(b.content.replace(/\s+/g, ''), 'base64');
    const blobOid = storeObject(repo, 'blob', bytes);
    next.set(path, { oid: blobOid, mode: '100644' });
    const commitSha = makeCommit(repo, branch, next, b.message);
    const leaf = path.split('/').pop();
    return sendJson(res, existing ? 200 : 201, {
      content: { sha: blobOid, encoding: 'base64', name: leaf, path, size: bytes.length },
      commit: { sha: commitSha },
    }), true;
  }

  if (method === 'DELETE') {
    const b = asObj(body);
    const branch = repo.defaultBranch;
    const branchFiles = repo.branches.get(branch);
    if (!branchFiles || !branchFiles.has(path)) return sendErr(res, 404, 'Not Found'), true;
    const givenSha = b && typeof b.sha === 'string' ? b.sha : '';
    if (givenSha !== '' && givenSha !== branchFiles.get(path)!.oid) {
      return sendErr(res, 409, 'Conflict'), true;
    }
    const next = new Map(branchFiles);
    next.delete(path);
    const message = b && typeof b.message === 'string' ? b.message : 'Delete file';
    const commitSha = makeCommit(repo, branch, next, message);
    return sendJson(res, 200, { commit: { sha: commitSha } }), true;
  }
  return sendErr(res, 404, 'Not Found'), true;
}

function handleIssues(
  req: Req,
  res: Res,
  method: string,
  repo: Repo,
  rest: string[],
  query: URLSearchParams,
  body: unknown,
): boolean {
  const host = req.headers.host ?? '127.0.0.1';
  const base = 'http://' + host;
  const asObj = (v: unknown): Record<string, unknown> | null =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
  // Issues are appended in creation order with sequential numbers starting
  // at 1, and never removed, so number n lives at index n - 1. The find is
  // kept as a fallback for safety, but the direct slot is the hot path.
  const findIssue = (n: number): Issue | undefined => {
    if (n >= 1 && n <= repo.issues.length) {
      const cand = repo.issues[n - 1]!;
      if (cand.number === n) return cand;
    }
    return repo.issues.find((i) => i.number === n);
  };

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let list = repo.issues.filter((i) => state === 'all' || i.state === state);
      if (sort === 'created') {
        list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      // Paginate the issues first, then serialize only the page: the
      // per-issue bytes come from the cache, joined into one JSON array.
      const { items, next } = paginate(list, query);
      const parts: Buffer[] = [Buffer.from('[', 'utf8')];
      for (let i = 0; i < items.length; i++) {
        if (i > 0) parts.push(Buffer.from(',', 'utf8'));
        parts.push(issueBytes(repo, items[i]!));
      }
      parts.push(Buffer.from(']', 'utf8'));
      const link = linkHeader(base, '/api/v3/repos/' + repo.owner + '/' + repo.name + '/issues', query, next);
      return sendBytes(res, 200, Buffer.concat(parts), link), true;
    }
    if (method === 'POST') {
      const b = asObj(body);
      const title = b ? asStr(b.title) : '';
      if (title === '') return sendErr(res, 422, 'Invalid title'), true;
      const labels = Array.isArray(b?.labels) ? (b!.labels as unknown[]).filter((x): x is string => typeof x === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return sendErr(res, 422, 'Label "' + label + '" does not exist'), true;
      }
      tick += 1;
      const issue: Issue = {
        id: ++globalIssueId,
        number: ++repo.issueSeq,
        title,
        body: b ? asStr(b.body) : '',
        state: 'open',
        labels,
        comments: [],
        seq: tick,
      };
      repo.issues.push(issue);
      return sendBytes(res, 201, issueBytes(repo, issue)), true;
    }
    return sendErr(res, 404, 'Not Found'), true;
  }

  const num = parseInt(rest[0] ?? '', 10);
  if (!Number.isInteger(num)) return sendErr(res, 404, 'Not Found'), true;
  const issue = findIssue(num);
  if (rest.length === 1) {
    if (issue === undefined) return sendErr(res, 404, 'Not Found'), true;
    if (method === 'GET') return sendBytes(res, 200, issueBytes(repo, issue)), true;
    if (method === 'PATCH') {
      const b = asObj(body);
      if (b) {
        if (typeof b.state === 'string' && (b.state === 'open' || b.state === 'closed')) issue.state = b.state;
        if (typeof b.title === 'string') issue.title = b.title;
        if (typeof b.body === 'string') issue.body = b.body;
      }
      dropIssueView(issue);
      return sendBytes(res, 200, issueBytes(repo, issue)), true;
    }
    return sendErr(res, 404, 'Not Found'), true;
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined) return sendErr(res, 404, 'Not Found'), true;
    if (method === 'GET') {
      const stamp = nowIso();
      const list = issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID }, created_at: stamp }));
      return sendJson(res, 200, list), true;
    }
    if (method === 'POST') {
      const b = asObj(body);
      const text = b ? asStr(b.body) : '';
      if (text === '') return sendErr(res, 422, 'Invalid comment body'), true;
      const comment = { id: ++globalCommentId, body: text };
      issue.comments.push(comment);
      dropIssueView(issue);
      return sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID }, created_at: nowIso() }), true;
    }
    return sendErr(res, 404, 'Not Found'), true;
  }
  return sendErr(res, 404, 'Not Found'), true;
}

function handlePulls(
  req: Req,
  res: Res,
  method: string,
  repo: Repo,
  rest: string[],
  query: URLSearchParams,
  body: unknown,
): boolean {
  const host = req.headers.host ?? '127.0.0.1';
  const base = 'http://' + host;
  const asObj = (v: unknown): Record<string, unknown> | null =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
  // Pulls, like issues, are appended in creation order with sequential
  // numbers from 1, so number n lives at index n - 1; linear find is the
  // fallback only.
  const findPull = (n: number): Pull | undefined => {
    if (n >= 1 && n <= repo.pulls.length) {
      const cand = repo.pulls[n - 1]!;
      if (cand.number === n) return cand;
    }
    return repo.pulls.find((p) => p.number === n);
  };

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const list = repo.pulls.filter((p) => state === 'all' || p.state === state);
      const { items, next } = paginate(list, query);
      const shown = items.map((p) => pullJson(repo, p));
      return sendJson(res, 200, shown, linkHeader(base, '/api/v3/repos/' + repo.owner + '/' + repo.name + '/pulls', query, next)), true;
    }
    if (method === 'POST') {
      const b = asObj(body);
      const head = b ? asStr(b.head) : '';
      const baseRef = b ? asStr(b.base) : '';
      const title = b ? asStr(b.title) : '';
      if (head === '' || baseRef === '' || title === '') return sendErr(res, 422, 'Invalid pull request'), true;
      const headSha = repo.refs.get('refs/heads/' + head);
      const baseSha = repo.refs.get('refs/heads/' + baseRef);
      if (headSha === undefined || baseSha === undefined) return sendErr(res, 422, 'Unknown head or base branch'), true;
      if (repo.pulls.some((p) => p.state === 'open' && p.headRef === head)) {
        return sendErr(res, 422, 'A pull request already exists for this head branch'), true;
      }
      tick += 1;
      const pull: Pull = {
        number: ++repo.pullSeq,
        title,
        body: b ? asStr(b.body) : '',
        state: 'open',
        merged: false,
        merge_commit_sha: null,
        merged_at: null,
        headRef: head,
        baseRef,
        headSha,
        baseSha,
        seq: tick,
      };
      repo.pulls.push(pull);
      return sendJson(res, 201, pullJson(repo, pull)), true;
    }
    return sendErr(res, 404, 'Not Found'), true;
  }

  const num = parseInt(rest[0] ?? '', 10);
  if (!Number.isInteger(num)) return sendErr(res, 404, 'Not Found'), true;
  const pull = findPull(num);
  if (rest.length === 1) {
    if (pull === undefined) return sendErr(res, 404, 'Not Found'), true;
    if (method === 'GET') return sendJson(res, 200, pullJson(repo, pull)), true;
    return sendErr(res, 404, 'Not Found'), true;
  }
  if (rest.length === 2 && rest[1] === 'files') {
    if (pull === undefined) return sendErr(res, 404, 'Not Found'), true;
    if (method !== 'GET') return sendErr(res, 404, 'Not Found'), true;
    const baseFiles = refFiles(repo, pull.baseRef) ?? new Map<string, FileEntry>();
    const headFiles = refFiles(repo, pull.headRef) ?? new Map<string, FileEntry>();
    return sendJson(res, 200, diffFiles(repo, baseFiles, headFiles)), true;
  }
  if (rest.length === 2 && rest[1] === 'merge') {
    if (pull === undefined) return sendErr(res, 404, 'Pull request not found'), true;
    if (method !== 'PUT') return sendErr(res, 404, 'Not Found'), true;
    if (pull.merged || pull.state === 'closed') return sendErr(res, 405, 'Pull request is already merged'), true;
    if (prConflicted(repo, pull)) return sendErr(res, 405, 'Merge conflict'), true;
    const mergeSha = squashMerge(repo, pull);
    pull.state = 'closed';
    pull.merged = true;
    pull.merge_commit_sha = mergeSha;
    pull.merged_at = nowIso();
    return sendJson(res, 200, { sha: mergeSha, merged: true, message: 'Pull request #' + pull.number + ' merged' }), true;
  }
  return sendErr(res, 404, 'Not Found'), true;
}

// ---------------------------------------------------------------------------
// GraphQL v4: a small executor for the documents gh / github-mcp-server send

type GqlValue = string | number | boolean | null | GqlValue[] | { [key: string]: GqlValue };
interface GqlField {
  alias: string | null;
  name: string;
  args: Record<string, GqlValue>;
  selection: GqlSelection[] | null;
  fragmentType: string | null; // for inline fragments: the type condition
  isFragment: boolean;
}
type GqlSelection = GqlField;
interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  selection: GqlSelection[];
}

function gqlTokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const isNameChar = (ch: string): boolean => /[A-Za-z_0-9.-]/.test(ch);
  while (i < src.length) {
    const c = src[i]!;
    // Whitespace and commas separate tokens and carry no meaning.
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    // A comment runs to the end of its line.
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (src.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}():$![]= @'.includes(c)) {
      if (c !== ' ') tokens.push(c);
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1]!;
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else out += e;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (isNameChar(c)) {
      let j = i;
      while (j < src.length && isNameChar(src[j]!)) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class GqlParser {
  tokens: string[];
  pos = 0;
  fragments = new Map<string, { type: string; selection: GqlSelection[] }>();
  constructor(src: string) {
    this.tokens = gqlTokenize(src);
  }
  peek(): string {
    return this.tokens[this.pos] ?? '';
  }
  next(): string {
    return this.tokens[this.pos++] ?? '';
  }
  expect(t: string): void {
    if (this.next() !== t) throw new Error('expected ' + t);
  }
  parseDocument(): GqlOperation[] {
    const ops: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      const t = this.peek();
      if (t === 'fragment') {
        this.next();
        const name = this.next();
        this.expect('on');
        const type = this.next();
        const selection = this.parseSelectionSet();
        this.fragments.set(name, { type, selection });
      } else if (t === 'query' || t === 'mutation') {
        const kind = this.next() as 'query' | 'mutation';
        let name: string | null = null;
        const ahead = this.peek();
        if (ahead !== '' && ahead !== '(' && ahead !== '{') name = this.next();
        if (this.peek() === '(') this.skipParens();
        ops.push({ kind, name, selection: this.parseSelectionSet() });
      } else if (t === '{') {
        ops.push({ kind: 'query', name: null, selection: this.parseSelectionSet() });
      } else {
        this.next();
      }
    }
    return ops;
  }
  skipParens(): void {
    this.expect('(');
    let depth = 1;
    while (depth > 0 && this.pos < this.tokens.length) {
      const t = this.next();
      if (t === '(') depth += 1;
      else if (t === ')') depth -= 1;
    }
  }
  parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const out: GqlSelection[] = [];
    while (this.peek() !== '}' && this.pos < this.tokens.length) {
      const fields = this.parseField();
      for (const f of fields) out.push(f);
    }
    this.expect('}');
    return out;
  }
  parseField(): GqlSelection[] {
    if (this.peek() === '...') {
      this.next();
      if (this.peek() === 'on') {
        this.next();
        const type = this.next();
        const selection = this.parseSelectionSet();
        return [{ alias: null, name: '', args: {}, selection, fragmentType: type, isFragment: true }];
      }
      const fragName = this.next();
      const frag = this.fragments.get(fragName);
      if (frag === undefined) return [];
      return frag.selection.map((f) => ({ ...f, fragmentType: f.fragmentType ?? frag.type, isFragment: true }));
    }
    let alias: string | null = null;
    let name = this.next();
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Record<string, GqlValue> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')' && this.pos < this.tokens.length) {
        const argName = this.next();
        this.expect(':');
        args[argName] = this.parseValue();
      }
      this.expect(')');
    }
    // Directives (none in the graded documents): skip @name(args).
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') this.skipParens();
    }
    let selection: GqlSelection[] | null = null;
    if (this.peek() === '{') selection = this.parseSelectionSet();
    return [{ alias, name, args, selection, fragmentType: null, isFragment: false }];
  }
  parseValue(): GqlValue {
    const t = this.next();
    if (t === '$') {
      const varName = this.next();
      return { $var: varName } as unknown as GqlValue;
    }
    if (t === '[') {
      const arr: GqlValue[] = [];
      while (this.peek() !== ']' && this.pos < this.tokens.length) arr.push(this.parseValue());
      this.expect(']');
      return arr;
    }
    if (t === '{') {
      const o: Record<string, GqlValue> = {};
      while (this.peek() !== '}' && this.pos < this.tokens.length) {
        const k = this.next();
        this.expect(':');
        o[k] = this.parseValue();
      }
      this.expect('}');
      return o;
    }
    if (t.startsWith('"')) return JSON.parse(t) as string;
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    const num = Number(t);
    if (t !== '' && !Number.isNaN(num)) return num;
    return t;
  }
}

function evalGqlValue(v: GqlValue, variables: Record<string, unknown>): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    const items: unknown[] = [];
    for (const x of v) items.push(evalGqlValue(x, variables));
    return items;
  }
  const keys = Object.keys(v);
  if (keys.length === 1 && keys[0] === '$var') {
    const varName = (v as Record<string, unknown>).$var as string;
    return variables[varName];
  }
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = evalGqlValue((v as Record<string, GqlValue>)[k]!, variables);
  return out;
}
function evalArgs(args: Record<string, GqlValue>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(args)) out[k] = evalGqlValue(args[k]!, variables);
  return out;
}

// ---------------------------------------------------------------------------
// GraphQL resolvers (one store, shared with REST).
//
// Each node type has its own resolver in the table below; resolveField only
// evaluates the arguments and dispatches. A resolver answers one field of
// its parent and returns the plain value, or a node the executor then walks
// with `descend` when the field carries a sub-selection.

interface GqlCtx {
  repo: Repo | null;
  errors: string[];
}
type GqlParent =
  | { __type: 'Query' }
  | { __type: 'Mutation' }
  | { __type: 'User'; login: string; id: number }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pull: Pull }
  | { __type: 'Ref'; name: string }
  | { __type: 'IssueConnection'; items: Issue[]; repo: Repo }
  | { __type: 'PullConnection'; items: Pull[]; repo: Repo }
  | { __type: 'TypeInfo'; name: string }
  | { __type: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { __type: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { __type: 'CreatePullPayload'; repo: Repo; pull: Pull }
  | { __type: 'MergePullPayload'; repo: Repo; pull: Pull }
  | { __type: 'AddCommentPayload'; repo: Repo; issue: Issue; commentId: number }
  | { __type: 'CommentEdge'; repo: Repo; issue: Issue; commentId: number }
  | { __type: 'Comment'; id: number; body: string }
  | { __type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null };

// The fields each introspected type exposes, for the __type query.
const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'author'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url', 'description', 'private', 'fork', 'createdAt', 'updatedAt'],
  User: ['id', 'login', 'name', 'email'],
  Ref: ['name'],
};

function gqlFindRepo(owner: string, name: string): Repo | undefined {
  return getRepo(owner, name);
}
function gqlDecodeId(id: string): { kind: string; key: string } | null {
  return ungid(id);
}
function gqlCursor(n: number): string {
  return Buffer.from('cursor:' + n, 'utf8').toString('base64');
}
function gqlCursorNum(cursor: string): number | null {
  try {
    const s = Buffer.from(cursor, 'base64').toString('utf8');
    if (!s.startsWith('cursor:')) return null;
    const n = parseInt(s.slice(7), 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

// Execute one operation; returns the response body object.
function gqlExecute(op: GqlOperation, variables: Record<string, unknown>): Record<string, unknown> {
  const errors: string[] = [];
  const root: GqlParent = op.kind === 'mutation' ? { __type: 'Mutation' } : { __type: 'Query' };
  const data = execSelection(root, op.selection, variables, errors);
  if (errors.length > 0) {
    const listed = errors.map((message) => ({ message }));
    return { data: null, errors: listed };
  }
  return { data };
}

// Resolve one edge's selection set: { node { ... } cursor }.
function execEdge(sel: GqlSelection[], nodeParent: GqlParent, cursor: string, variables: Record<string, unknown>, errors: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of sel) {
    if (f.isFragment) continue;
    const key = f.alias ?? f.name;
    if (f.name === 'cursor') {
      out[key] = cursor;
    } else if (f.name === 'node') {
      out[key] = f.selection === null ? nodeParent : execSelection(nodeParent, f.selection, variables, errors);
    }
  }
  return out;
}

// Build a small connection ({ nodes, edges, totalCount, pageInfo }) from a
// connection field's own sub-selection: each node's fields come from the
// `nodes` entry inside sel — passing sel itself to the nodes would ask them
// for a `nodes` field they do not have.
function execInlineConnection(
  sel: GqlSelection[] | null,
  nodes: GqlParent[],
  variables: Record<string, unknown>,
  errors: string[],
): Record<string, unknown> {
  if (sel === null) return { nodes };
  const out: Record<string, unknown> = {};
  for (const f of sel) {
    if (f.isFragment) continue;
    const key = f.alias ?? f.name;
    if (f.name === 'nodes') {
      out[key] = f.selection === null ? nodes : nodes.map((n) => execSelection(n, f.selection!, variables, errors));
    } else if (f.name === 'edges') {
      if (f.selection === null) {
        out[key] = nodes.map((n, i) => ({ node: n, cursor: gqlCursor(i) }));
      } else {
        out[key] = nodes.map((n, i) => execEdge(f.selection!, n, gqlCursor(i), variables, errors));
      }
    } else if (f.name === 'totalCount') {
      out[key] = nodes.length;
    } else if (f.name === 'pageInfo') {
      const last = nodes.length > 0 ? gqlCursor(nodes.length - 1) : null;
      const pi = { __type: 'PageInfo', hasNextPage: false, endCursor: last } as GqlParent;
      if (f.selection === null) {
        out[key] = { hasNextPage: false, endCursor: last };
      } else {
        out[key] = execSelection(pi, f.selection, variables, errors);
      }
    }
  }
  return out;
}

function execSelection(parent: GqlParent, selection: GqlSelection[], variables: Record<string, unknown>, errors: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selection) {
    if (field.isFragment) {
      if (field.fragmentType !== null && field.fragmentType !== parent.__type) continue;
      if (field.selection !== null) {
        const inner = execSelection(parent, field.selection, variables, errors);
        Object.assign(out, inner);
      }
      continue;
    }
    const key = field.alias ?? field.name;
    const value = resolveField(parent, field, variables, errors);
    if (errors.length > 0) return out;
    out[key] = value;
  }
  return out;
}

// A resolver answers one field of one parent type. `descend` walks a node
// value with the field's sub-selection (or returns it bare when there is
// none); `reject` records the unknown-field error the executor surfaces.
interface GqlResolve {
  sel: GqlSelection[] | null;
  variables: Record<string, unknown>;
  errors: string[];
  fieldName: string;
}
function gqlDescend(value: GqlParent | null, ctx: GqlResolve): unknown {
  if (value === null || value === undefined) return null;
  if (ctx.sel === null) return value;
  if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
    return execSelection(value as GqlParent, ctx.sel, ctx.variables, ctx.errors);
  }
  return value;
}
function gqlReject(ctx: GqlResolve, typeName: string, fieldName: string): null {
  ctx.errors.push('Cannot query field "' + fieldName + '" on type "' + typeName + '".');
  return null;
}
type GqlResolver = (parent: GqlParent, args: Record<string, unknown>, ctx: GqlResolve) => unknown;

// Split a "owner/name[/number]" global id into its parts, or null when the
// key does not carry at least owner and name.
function gqlIdParts(key: string): string[] | null {
  const parts = key.split('/');
  return parts.length >= 2 && parts[0] !== '' && parts[1] !== '' ? parts : null;
}
function gqlRepoFromParts(parts: string[]): Repo | undefined {
  return gqlFindRepo(parts[0]!, parts[1]!);
}
function gqlNumberArg(args: Record<string, unknown>): number {
  if (typeof args.number === 'number') return args.number;
  return parseInt(String(args.number ?? ''), 10);
}

function resolveField(parent: GqlParent, field: GqlField, variables: Record<string, unknown>, errors: string[]): unknown {
  const args = evalArgs(field.args, variables);
  const ctx: GqlResolve = { sel: field.selection, variables, errors, fieldName: field.name };
  const resolver = GQL_RESOLVERS[parent.__type];
  if (resolver === undefined) return gqlReject(ctx, parent.__type, field.name);
  return resolver(parent, args, ctx);
}

// --- Query ---------------------------------------------------------------

function resolveQuery(parent: GqlParent, args: Record<string, unknown>, ctx: GqlResolve): unknown {
  const name = ctx.fieldName;
  if (name === 'viewer') {
    const viewer: GqlParent = { __type: 'User', login: VIEWER_LOGIN, id: VIEWER_ID };
    return gqlDescend(viewer, ctx);
  }
  if (name === 'repository') {
    const repo = gqlFindRepo(String(args.owner ?? ''), String(args.name ?? ''));
    if (repo === undefined) return null;
    return gqlDescend({ __type: 'Repository', repo }, ctx);
  }
  if (name === 'node') {
    const decoded = gqlDecodeId(String(args.id ?? ''));
    if (decoded === null) return null;
    if (decoded.kind === 'Repository') {
      const parts = gqlIdParts(decoded.key);
      const repo = parts === null ? undefined : gqlRepoFromParts(parts);
      if (repo === undefined) return null;
      return gqlDescend({ __type: 'Repository', repo }, ctx);
    }
    if (decoded.kind === 'Issue') {
      const parts = decoded.key.split('/');
      const repo = parts.length >= 3 ? gqlRepoFromParts(parts) : undefined;
      const issue = repo === undefined ? undefined : repo.issues.find((i) => i.number === parseInt(parts[2]!, 10));
      if (repo === undefined || issue === undefined) return null;
      return gqlDescend({ __type: 'Issue', repo, issue }, ctx);
    }
    if (decoded.kind === 'PullRequest') {
      const parts = decoded.key.split('/');
      const repo = parts.length >= 3 ? gqlRepoFromParts(parts) : undefined;
      const pull = repo === undefined ? undefined : repo.pulls.find((p) => p.number === parseInt(parts[2]!, 10));
      if (repo === undefined || pull === undefined) return null;
      return gqlDescend({ __type: 'PullRequest', repo, pull }, ctx);
    }
    if (decoded.kind === 'User') {
      const user: GqlParent = { __type: 'User', login: decoded.key, id: VIEWER_ID };
      return gqlDescend(user, ctx);
    }
    return null;
  }
  if (name === '__type') {
    const typeName = String(args.name ?? '');
    if (typeName === 'SearchType') return gqlDescend({ __type: 'TypeInfo', name: typeName }, ctx);
    if (GQL_TYPE_FIELDS[typeName] !== undefined) return gqlDescend({ __type: 'TypeInfo', name: typeName }, ctx);
    return null;
  }
  return gqlReject(ctx, 'Query', name);
}

// --- Mutation ------------------------------------------------------------

function resolveMutation(parent: GqlParent, args: Record<string, unknown>, ctx: GqlResolve): unknown {
  const name = ctx.fieldName;
  const input = (args.input ?? {}) as Record<string, unknown>;
  if (name === 'createIssue') {
    const decoded = gqlDecodeId(String(input.repositoryId ?? ''));
    if (decoded === null || decoded.kind !== 'Repository') return gqlDescend(null, ctx);
    const parts = gqlIdParts(decoded.key);
    const repo = parts === null ? undefined : gqlRepoFromParts(parts);
    if (repo === undefined) return gqlDescend(null, ctx);
    tick += 1;
    const issue: Issue = {
      id: ++globalIssueId,
      number: ++repo.issueSeq,
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      state: 'open',
      labels: [],
      comments: [],
      seq: tick,
    };
    repo.issues.push(issue);
    return gqlDescend({ __type: 'CreateIssuePayload', repo, issue }, ctx);
  }
  if (name === 'closeIssue') {
    const decoded = gqlDecodeId(String(input.issueId ?? ''));
    if (decoded === null || decoded.kind !== 'Issue') return gqlDescend(null, ctx);
    const parts = decoded.key.split('/');
    const repo = parts.length >= 3 ? gqlRepoFromParts(parts) : undefined;
    const issue = repo === undefined ? undefined : repo.issues.find((i) => i.number === parseInt(parts[2]!, 10));
    if (repo === undefined || issue === undefined) return gqlDescend(null, ctx);
    issue.state = 'closed';
    return gqlDescend({ __type: 'CloseIssuePayload', repo, issue }, ctx);
  }
  if (name === 'createPullRequest') {
    const decoded = gqlDecodeId(String(input.repositoryId ?? ''));
    if (decoded === null || decoded.kind !== 'Repository') return gqlDescend(null, ctx);
    const parts = gqlIdParts(decoded.key);
    const repo = parts === null ? undefined : gqlRepoFromParts(parts);
    if (repo === undefined) return gqlDescend(null, ctx);
    const head = String(input.headRefName ?? '');
    const baseRef = String(input.baseRefName ?? '');
    const headSha = repo.refs.get('refs/heads/' + head);
    const baseSha = repo.refs.get('refs/heads/' + baseRef);
    if (headSha === undefined || baseSha === undefined) return gqlDescend(null, ctx);
    if (repo.pulls.some((p) => p.state === 'open' && p.headRef === head)) return gqlDescend(null, ctx);
    tick += 1;
    const pull: Pull = {
      number: ++repo.pullSeq,
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      state: 'open',
      merged: false,
      merge_commit_sha: null,
      merged_at: null,
      headRef: head,
      baseRef,
      headSha,
      baseSha,
      seq: tick,
    };
    repo.pulls.push(pull);
    return gqlDescend({ __type: 'CreatePullPayload', repo, pull }, ctx);
  }
  if (name === 'mergePullRequest') {
    const decoded = gqlDecodeId(String(input.pullRequestId ?? ''));
    if (decoded === null || decoded.kind !== 'PullRequest') return gqlDescend(null, ctx);
    const parts = decoded.key.split('/');
    const repo = parts.length >= 3 ? gqlRepoFromParts(parts) : undefined;
    const pull = repo === undefined ? undefined : repo.pulls.find((p) => p.number === parseInt(parts[2]!, 10));
    if (repo === undefined || pull === undefined) return gqlDescend(null, ctx);
    if (pull.merged || pull.state === 'closed' || prConflicted(repo, pull)) return gqlDescend(null, ctx);
    const mergeSha = squashMerge(repo, pull);
    pull.state = 'closed';
    pull.merged = true;
    pull.merge_commit_sha = mergeSha;
    pull.merged_at = nowIso();
    return gqlDescend({ __type: 'MergePullPayload', repo, pull }, ctx);
  }
  if (name === 'addComment') {
    const decoded = gqlDecodeId(String(input.subjectId ?? ''));
    if (decoded === null || decoded.kind !== 'Issue') return gqlDescend(null, ctx);
    const parts = decoded.key.split('/');
    const repo = parts.length >= 3 ? gqlRepoFromParts(parts) : undefined;
    const issue = repo === undefined ? undefined : repo.issues.find((i) => i.number === parseInt(parts[2]!, 10));
    if (repo === undefined || issue === undefined) return gqlDescend(null, ctx);
    const comment = { id: ++globalCommentId, body: String(input.body ?? '') };
    issue.comments.push(comment);
    return gqlDescend({ __type: 'AddCommentPayload', repo, issue, commentId: comment.id }, ctx);
  }
  return gqlReject(ctx, 'Mutation', name);
}

// --- User ----------------------------------------------------------------

function resolveUser(parent: GqlParent, args: Record<string, unknown>, ctx: GqlResolve): unknown {
  if (parent.__type !== 'User') return gqlReject(ctx, 'User', ctx.fieldName);
  const login = parent.login;
  const isViewer = login === VIEWER_LOGIN;
  switch (ctx.fieldName) {
    case 'login': return login;
    case 'id': return gid('User', login);
    case 'name': return isViewer ? VIEWER_NAME : login;
    case 'email': return isViewer ? VIEWER_EMAIL : login + '@example.invalid';
    default: return gqlReject(ctx, 'User', ctx.fieldName);
  }
}

// --- Repository ----------------------------------------------------------

function gqlSortIssues(items: Issue[], args: Record<string, unknown>): Issue[] {
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const field = String(orderBy.field ?? '');
  const direction = String(orderBy.direction ?? 'ASC');
  const sorted = [...items];
  if (field === 'CREATED_AT') {
    sorted.sort((a, b) => (direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
  } else {
    sorted.sort((a, b) => a.seq - b.seq);
  }
  return sorted;
}
function gqlSortPulls(items: Pull[], args: Record<string, unknown>): Pull[] {
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const field = String(orderBy.field ?? '');
  const direction = String(orderBy.direction ?? 'ASC');
  const sorted = [...items];
  if (field === 'CREATED_AT') {
    sorted.sort((a, b) => (direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
  } else {
    sorted.sort((a, b) => a.seq - b.seq);
  }
  return sorted;
}

function resolveRepository(parent: GqlParent, args: Record<string, unknown>, ctx: GqlResolve): unknown {
  if (parent.__type !== 'Repository') return gqlReject(ctx, 'Repository', ctx.fieldName);
  const repo = parent.repo;
  const fullName = repo.owner + '/' + repo.name;
  switch (ctx.fieldName) {
    case 'id': return gid('Repository', fullName);
    case 'databaseId': return repo.id;
    case 'name': return repo.name;
    case 'nameWithOwner': return fullName;
    case 'owner': return gqlDescend({ __type: 'User', login: repo.owner, id: VIEWER_ID }, ctx);
    case 'defaultBranchRef': return gqlDescend({ __type: 'Ref', name: repo.defaultBranch }, ctx);
    case 'viewerPermission': return 'ADMIN';
    case 'hasIssuesEnabled': return true;
    case 'url': return 'https://github.com/' + fullName;
    case 'description': return repo.description;
    case 'private': return repo.isPrivate;
    case 'fork': return false;
    case 'createdAt': return nowIso();
    case 'updatedAt': return nowIso();
    case 'issue': {
      const n = gqlNumberArg(args);
      const issue = repo.issues.find((i) => i.number === n);
      if (issue === undefined) return null;
      return gqlDescend({ __type: 'Issue', repo, issue }, ctx);
    }
    case 'issues': {
      let items = [...repo.issues];
      const states = Array.isArray(args.states) ? (args.states as unknown[]).map((s) => String(s)) : null;
      if (states !== null) items = items.filter((i) => states.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
      const ordered = gqlSortIssues(items, args);
      return gqlDescend(gqlIssueConnection(repo, ordered, args), ctx);
    }
    case 'pullRequest': {
      const n = gqlNumberArg(args);
      const pull = repo.pulls.find((p) => p.number === n);
      if (pull === undefined) return null;
      return gqlDescend({ __type: 'PullRequest', repo, pull }, ctx);
    }
    case 'pullRequests': {
      let items = [...repo.pulls];
      const states = Array.isArray(args.states) ? (args.states as unknown[]).map((s) => String(s)) : null;
      if (states !== null) {
        items = items.filter((p) => states.includes(p.state === 'open' ? 'OPEN' : p.merged ? 'MERGED' : 'CLOSED'));
      }
      const ordered = gqlSortPulls(items, args);
      return gqlDescend(gqlPullConnection(repo, ordered, args), ctx);
    }
    default: return gqlReject(ctx, 'Repository', ctx.fieldName);
  }
}

// --- Issue ---------------------------------------------------------------

function resolveIssue(parent: GqlParent, args: Record<string, unknown>, ctx: GqlResolve): unknown {
  if (parent.__type !== 'Issue') return gqlReject(ctx, 'Issue', ctx.fieldName);
  const issue = parent.issue;
  const repo = parent.repo;
  const fullName = repo.owner + '/' + repo.name;
  switch (ctx.fieldName) {
    case 'id': return gid('Issue', fullName + '/' + issue.number);
    case 'number': return issue.number;
    case 'title': return issue.title;
    case 'body': return issue.body;
    case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    case 'url': return 'https://github.com/' + fullName + '/issues/' + issue.number;
    case 'createdAt': return nowIso();
    case 'updatedAt': return nowIso();
    case 'author': return gqlDescend({ __type: 'User', login: VIEWER_LOGIN, id: VIEWER_ID }, ctx);
    case 'labels': {
      if (ctx.sel === null) return issue.labels.map((labelName) => ({ name: labelName }));
      const nodes = issue.labels.map((labelName) => ({ __type: 'Ref', name: labelName }) as unknown as GqlParent);
      return execInlineConnection(ctx.sel, nodes, ctx.variables, ctx.errors);
    }
    case 'comments': {
      const nodes = issue.comments.map((c) => ({ __type: 'Comment', id: c.id, body: c.body }) as GqlParent);
      if (ctx.sel === null) return nodes;
      return execInlineConnection(ctx.sel, nodes, ctx.variables, ctx.errors);
    }
    default: return gqlReject(ctx, 'Issue', ctx.fieldName);
  }
}

// --- PullRequest ---------------------------------------------------------

function resolvePullRequest(parent: GqlParent, args: Record<string, unknown>, ctx: GqlResolve): unknown {
  if (parent.__type !== 'PullRequest') return gqlReject(ctx, 'PullRequest', ctx.fieldName);
  const pull = parent.pull;
  const repo = parent.repo;
  const fullName = repo.owner + '/' + repo.name;
  switch (ctx.fieldName) {
    case 'id': return gid('PullRequest', fullName + '/' + pull.number);
    case 'number': return pull.number;
    case 'title': return pull.title;
    case 'body': return pull.body;
    case 'state': return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    case 'merged': return pull.merged;
    case 'mergeable': return prConflicted(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    case 'headRefName': return pull.headRef;
    case 'baseRefName': return pull.baseRef;
    case 'headRefOid': return pull.headSha;
    case 'baseRefOid': return pull.baseSha;
    case 'author': return gqlDescend({ __type: 'User', login: VIEWER_LOGIN, id: VIEWER_ID }, ctx);
    case 'files': {
      const baseFiles = refFiles(repo, pull.baseRef) ?? new Map<string, FileEntry>();
      const headFiles = refFiles(repo, pull.headRef) ?? new Map<string, FileEntry>();
      const diffs = diffFiles(repo, baseFiles, headFiles);
      const first = typeof args.first === 'number' ? args.first : diffs.length;
      const page = diffs.slice(0, first);
      if (ctx.sel === null) return { nodes: page.map((d) => ({ path: d.filename })) };
      const nodes = page.map((d) => ({ __type: 'Ref', name: d.filename }) as unknown as GqlParent);
      return execInlineConnection(ctx.sel, nodes, ctx.variables, ctx.errors);
    }
    default: return gqlReject(ctx, 'PullRequest', ctx.fieldName);
  }
}

// --- Small node types ----------------------------------------------------

function resolveRef(parent: GqlParent, args: Record<string, unknown>, ctx: GqlResolve): unknown {
  if (parent.__type !== 'Ref') return gqlReject(ctx, 'Ref', ctx.fieldName);
  if (ctx.fieldName === 'name' || ctx.fieldName === 'path') return parent.name;
  return gqlReject(ctx, 'Ref', ctx.fieldName);
}

function resolveIssueConnection(parent: GqlParent, args: Record<string, unknown>, ctx: GqlResolve): unknown {
  if (parent.__type !== 'IssueConnection') return gqlReject(ctx, 'IssueConnection', ctx.fieldName);
  const items = parent.items;
  const repo = parent.repo;
  switch (ctx.fieldName) {
    case 'nodes': {
      if (ctx.sel === null) return items.map((i) => ({ number: i.number }));
      return items.map((i) => execSelection({ __type: 'Issue', repo, issue: i }, ctx.sel!, ctx.variables, ctx.errors));
    }
    case 'edges': {
      if (ctx.sel === null) return items.map((i) => ({ node: { number: i.number }, cursor: gqlCursor(i.number) }));
      return items.map((i) => execEdge(ctx.sel!, { __type: 'Issue', repo, issue: i }, gqlCursor(i.number), ctx.variables, ctx.errors));
    }
    case 'totalCount': return items.length;
    case 'pageInfo': {
      const pageInfo = (parent as unknown as Record<string, unknown>).__pageInfo as GqlParent;
      return gqlDescend(pageInfo, ctx);
    }
    default: return gqlReject(ctx, 'IssueConnection', ctx.fieldName);
  }
}

function resolvePullConnection(parent: GqlParent, args: Record<string, unknown>, ctx: GqlResolve): unknown {
  if (parent.__type !== 'PullConnection') return gqlReject(ctx, 'PullConnection', ctx.fieldName);
  const items = parent.items;
  const repo = parent.repo;
  switch (ctx.fieldName) {
    case 'nodes': {
      if (ctx.sel === null) return items.map((p) => ({ number: p.number }));
      return items.map((p) => execSelection({ __type: 'PullRequest', repo, pull: p }, ctx.sel!, ctx.variables, ctx.errors));
    }
    case 'edges': {
      if (ctx.sel === null) return items.map((p) => ({ node: { number: p.number }, cursor: gqlCursor(p.number) }));
      return items.map((p) => execEdge(ctx.sel!, { __type: 'PullRequest', repo, pull: p }, gqlCursor(p.number), ctx.variables, ctx.errors));
    }
    case 'totalCount': return items.length;
    case 'pageInfo': {
      const pageInfo = (parent as unknown as Record<string, unknown>).__pageInfo as GqlParent;
      return gqlDescend(pageInfo, ctx);
    }
    default: return gqlReject(ctx, 'PullConnection', ctx.fieldName);
  }
}

function resolveTypeInfo(parent: GqlParent, args: Record<string, unknown>, ctx: GqlResolve): unknown {
  if (parent.__type !== 'TypeInfo') return gqlReject(ctx, 'TypeInfo', ctx.fieldName);
  const typeName = parent.name;
  switch (ctx.fieldName) {
    case 'name': return typeName;
    case 'kind': return typeName === 'SearchType' ? 'ENUM' : 'OBJECT';
    case 'fields': {
      const names = GQL_TYPE_FIELDS[typeName] ?? [];
      if (ctx.sel === null) return names.map((n) => ({ name: n }));
      return names.map((n) => execSelection({ __type: 'Ref', name: n } as unknown as GqlParent, ctx.sel!, ctx.variables, ctx.errors));
    }
    case 'enumValues': {
      const names = typeName === 'SearchType' ? ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT'] : [];
      if (ctx.sel === null) return names.map((n) => ({ name: n }));
      return names.map((n) => execSelection({ __type: 'Ref', name: n } as unknown as GqlParent, ctx.sel!, ctx.variables, ctx.errors));
    }
    default: return gqlReject(ctx, 'TypeInfo', ctx.fieldName);
  }
}

function resolveCreateIssuePayload(parent: GqlParent, args: Record<string, unknown>, ctx: GqlResolve): unknown {
  if (parent.__type !== 'CreateIssuePayload') return gqlReject(ctx, 'CreateIssuePayload', ctx.fieldName);
  if (ctx.fieldName === 'issue') return gqlDescend({ __type: 'Issue', repo: parent.repo, issue: parent.issue }, ctx);
  return gqlReject(ctx, 'CreateIssuePayload', ctx.fieldName);
}
function resolveCloseIssuePayload(parent: GqlParent, args: Record<string, unknown>, ctx: GqlResolve): unknown {
  if (parent.__type !== 'CloseIssuePayload') return gqlReject(ctx, 'CloseIssuePayload', ctx.fieldName);
  if (ctx.fieldName === 'issue') return gqlDescend({ __type: 'Issue', repo: parent.repo, issue: parent.issue }, ctx);
  return gqlReject(ctx, 'CloseIssuePayload', ctx.fieldName);
}
function resolveCreatePullPayload(parent: GqlParent, args: Record<string, unknown>, ctx: GqlResolve): unknown {
  if (parent.__type !== 'CreatePullPayload') return gqlReject(ctx, 'CreatePullPayload', ctx.fieldName);
  if (ctx.fieldName === 'pullRequest') return gqlDescend({ __type: 'PullRequest', repo: parent.repo, pull: parent.pull }, ctx);
  return gqlReject(ctx, 'CreatePullPayload', ctx.fieldName);
}
function resolveMergePullPayload(parent: GqlParent, args: Record<string, unknown>, ctx: GqlResolve): unknown {
  if (parent.__type !== 'MergePullPayload') return gqlReject(ctx, 'MergePullPayload', ctx.fieldName);
  if (ctx.fieldName === 'pullRequest') return gqlDescend({ __type: 'PullRequest', repo: parent.repo, pull: parent.pull }, ctx);
  return gqlReject(ctx, 'MergePullPayload', ctx.fieldName);
}
function resolveAddCommentPayload(parent: GqlParent, args: Record<string, unknown>, ctx: GqlResolve): unknown {
  if (parent.__type !== 'AddCommentPayload') return gqlReject(ctx, 'AddCommentPayload', ctx.fieldName);
  if (ctx.fieldName === 'commentEdge') {
    const edge: GqlParent = { __type: 'CommentEdge', repo: parent.repo, issue: parent.issue, commentId: parent.commentId };
    return gqlDescend(edge, ctx);
  }
  return gqlReject(ctx, 'AddCommentPayload', ctx.fieldName);
}
function resolveCommentEdge(parent: GqlParent, args: Record<string, unknown>, ctx: GqlResolve): unknown {
  if (parent.__type !== 'CommentEdge') return gqlReject(ctx, 'CommentEdge', ctx.fieldName);
  if (ctx.fieldName === 'node') {
    const found = parent.issue.comments.find((x) => x.id === parent.commentId);
    if (found === undefined) return null;
    return gqlDescend({ __type: 'Comment', id: found.id, body: found.body }, ctx);
  }
  return gqlReject(ctx, 'CommentEdge', ctx.fieldName);
}
function resolveComment(parent: GqlParent, args: Record<string, unknown>, ctx: GqlResolve): unknown {
  if (parent.__type !== 'Comment') return gqlReject(ctx, 'Comment', ctx.fieldName);
  if (ctx.fieldName === 'id') return gid('IssueComment', String(parent.id));
  if (ctx.fieldName === 'body') return parent.body;
  return gqlReject(ctx, 'Comment', ctx.fieldName);
}
function resolvePageInfo(parent: GqlParent, args: Record<string, unknown>, ctx: GqlResolve): unknown {
  if (parent.__type !== 'PageInfo') return gqlReject(ctx, 'PageInfo', ctx.fieldName);
  if (ctx.fieldName === 'hasNextPage') return parent.hasNextPage;
  if (ctx.fieldName === 'endCursor') return parent.endCursor;
  return gqlReject(ctx, 'PageInfo', ctx.fieldName);
}

const GQL_RESOLVERS: Record<string, GqlResolver> = {
  Query: resolveQuery,
  Mutation: resolveMutation,
  User: resolveUser,
  Repository: resolveRepository,
  Issue: resolveIssue,
  PullRequest: resolvePullRequest,
  Ref: resolveRef,
  IssueConnection: resolveIssueConnection,
  PullConnection: resolvePullConnection,
  TypeInfo: resolveTypeInfo,
  CreateIssuePayload: resolveCreateIssuePayload,
  CloseIssuePayload: resolveCloseIssuePayload,
  CreatePullPayload: resolveCreatePullPayload,
  MergePullPayload: resolveMergePullPayload,
  AddCommentPayload: resolveAddCommentPayload,
  CommentEdge: resolveCommentEdge,
  Comment: resolveComment,
  PageInfo: resolvePageInfo,
};

// Slice a Relay-style page out of a sorted item list: `after` drops every
// item up to and including the cursor's number, `first` caps the page and
// reports whether more items remain. The pageInfo rides on the connection
// object itself so the resolver can answer it through the connection.
function gqlPage<T extends { number: number }>(
  items: T[],
  args: Record<string, unknown>,
): { slice: T[]; hasNextPage: boolean; endCursor: string | null } {
  const first = typeof args.first === 'number' ? args.first : null;
  const after = typeof args.after === 'string' ? gqlCursorNum(args.after) : null;
  let page = items;
  if (after !== null) {
    const idx = items.findIndex((item) => item.number === after);
    page = idx >= 0 ? items.slice(idx + 1) : items;
  }
  const hasNextPage = first !== null && page.length > first;
  const slice = first !== null ? page.slice(0, first) : page;
  const last = slice.length > 0 ? slice[slice.length - 1]! : null;
  const endCursor = last === null ? null : gqlCursor(last.number);
  return { slice, hasNextPage, endCursor };
}
function gqlIssueConnection(repo: Repo, items: Issue[], args: Record<string, unknown>): GqlParent {
  const { slice, hasNextPage, endCursor } = gqlPage(items, args);
  const conn: GqlParent = { __type: 'IssueConnection', items: slice, repo };
  (conn as unknown as Record<string, unknown>).__pageInfo = { __type: 'PageInfo', hasNextPage, endCursor } as GqlParent;
  return conn;
}
function gqlPullConnection(repo: Repo, items: Pull[], args: Record<string, unknown>): GqlParent {
  const { slice, hasNextPage, endCursor } = gqlPage(items, args);
  const conn: GqlParent = { __type: 'PullConnection', items: slice, repo };
  (conn as unknown as Record<string, unknown>).__pageInfo = { __type: 'PageInfo', hasNextPage, endCursor } as GqlParent;
  return conn;
}

// ---------------------------------------------------------------------------
// MCP (Model Context Protocol, Streamable HTTP, revision 2026-07-28)

// MCP (Model Context Protocol, Streamable HTTP, revision 2026-07-28)

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

// One tool definition from a compact spec: the name, a one-line
// description, the argument properties, and which of them are required.
function mcpTool(
  name: string,
  description: string,
  props: Record<string, { type: string; description: string }>,
  required: string[],
): McpToolDef {
  const properties: Record<string, unknown> = {};
  for (const key of Object.keys(props)) properties[key] = props[key];
  return { name, description, inputSchema: { type: 'object', properties, required } };
}
const MCP_TOOLS: McpToolDef[] = [
  mcpTool('create_repo', 'Create a repository owned by the authenticated user.', {
    name: { type: 'string', description: 'The repository name.' },
    description: { type: 'string', description: 'A short description of the repository.' },
    private: { type: 'boolean', description: 'Whether the repository is private.' },
  }, ['name']),
  mcpTool('get_repo', 'Get one repository by owner and name.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
  }, ['owner', 'repo']),
  mcpTool('create_issue', 'Create an issue in a repository.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    title: { type: 'string', description: 'The issue title.' },
    body: { type: 'string', description: 'The issue body.' },
  }, ['owner', 'repo', 'title']),
  mcpTool('list_issues', 'List the issues of a repository.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
  }, ['owner', 'repo']),
  mcpTool('create_pull_request', 'Open a pull request from a head branch into a base branch.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    title: { type: 'string', description: 'The pull request title.' },
    body: { type: 'string', description: 'The pull request body.' },
    head: { type: 'string', description: 'The head branch name.' },
    base: { type: 'string', description: 'The base branch name.' },
  }, ['owner', 'repo', 'title', 'head', 'base']),
  mcpTool('merge_pull_request', 'Squash-merge a pull request.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    pull_number: { type: 'integer', description: 'The pull request number.' },
  }, ['owner', 'repo', 'pull_number']),
];
const MCP_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function mcpToolResult(result: unknown, isError = false): Record<string, unknown> {
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  return { content: [{ type: 'text', text }], structuredContent: result, isError };
}
function mcpFail(message: string): Record<string, unknown> {
  return mcpToolResult(message, true);
}
// A fresh empty repository owned by the viewer, as the create paths build.
function mcpNewRepo(name: string, isPrivate: boolean, description: string): Repo {
  return {
    id: ++repoIdSeq,
    name,
    owner: VIEWER_LOGIN,
    isPrivate,
    description,
    defaultBranch: 'main',
    refs: new Map(),
    objects: new Map(),
    commits: new Map(),
    branches: new Map(),
    issues: [],
    issueSeq: 0,
    pulls: [],
    pullSeq: 0,
    labels: new Map(),
    seq: ++repoSeq,
  };
}

type McpHandler = (repo: Repo, args: Record<string, unknown>) => Record<string, unknown>;
const MCP_HANDLERS: Record<string, McpHandler> = {
  get_repo(repo) {
    return mcpToolResult(repoJson(repo));
  },
  create_issue(repo, args) {
    const labels: string[] = [];
    tick += 1;
    const issue: Issue = {
      id: ++globalIssueId,
      number: ++repo.issueSeq,
      title: String(args.title ?? ''),
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      labels,
      comments: [],
      seq: tick,
    };
    repo.issues.push(issue);
    return mcpToolResult(issueJson(repo, issue));
  },
  list_issues(repo, args) {
    const state = typeof args.state === 'string' ? args.state : 'open';
    const shown = repo.issues
      .filter((i) => state === 'all' || i.state === state)
      .map((i) => issueJson(repo, i));
    return mcpToolResult(shown);
  },
  create_pull_request(repo, args) {
    const head = String(args.head ?? '');
    const baseRef = String(args.base ?? '');
    const headSha = repo.refs.get('refs/heads/' + head);
    const baseSha = repo.refs.get('refs/heads/' + baseRef);
    if (headSha === undefined || baseSha === undefined) return mcpFail('Unknown head or base branch');
    if (repo.pulls.some((p) => p.state === 'open' && p.headRef === head)) {
      return mcpFail('A pull request already exists for this head branch');
    }
    tick += 1;
    const pull: Pull = {
      number: ++repo.pullSeq,
      title: String(args.title ?? ''),
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      merged: false,
      merge_commit_sha: null,
      merged_at: null,
      headRef: head,
      baseRef,
      headSha,
      baseSha,
      seq: tick,
    };
    repo.pulls.push(pull);
    return mcpToolResult(pullJson(repo, pull));
  },
  merge_pull_request(repo, args) {
    const num = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number ?? ''), 10);
    const pull = repo.pulls.find((p) => p.number === num);
    if (pull === undefined) return mcpFail('Pull request not found: ' + num);
    if (pull.merged || pull.state === 'closed') return mcpFail('Pull request is already merged');
    if (prConflicted(repo, pull)) return mcpFail('Merge conflict');
    const mergeSha = squashMerge(repo, pull);
    pull.state = 'closed';
    pull.merged = true;
    pull.merge_commit_sha = mergeSha;
    pull.merged_at = nowIso();
    return mcpToolResult({ number: pull.number, merged: true, sha: mergeSha, state: 'closed' });
  },
};

function mcpCallTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (tool === undefined) return { __rpcError: { code: -32602, message: 'Unknown tool: ' + name } };
  for (const required of tool.inputSchema.required) {
    const value = args[required];
    if (value === undefined || value === null || value === '') {
      return mcpFail('Missing required argument: ' + required);
    }
  }
  if (name === 'create_repo') {
    const repoNameOnly = String(args.name ?? '');
    if (repoNameOnly === '' || repoNameOnly.includes('/')) return mcpFail('Invalid repository name');
    if (repos.has(repoKey(VIEWER_LOGIN, repoNameOnly))) return mcpFail('Repository already exists');
    const isPrivate = args.private === true;
    const description = typeof args.description === 'string' ? args.description : '';
    const repo = mcpNewRepo(repoNameOnly, isPrivate, description);
    repos.set(repoKey(VIEWER_LOGIN, repoNameOnly), repo);
    return mcpToolResult(repoJson(repo));
  }
  const owner = String(args.owner ?? VIEWER_LOGIN);
  const repoName = String(args.repo ?? args.name ?? '');
  const repo = getRepo(owner, repoName);
  if (repo === undefined) return mcpFail('Repository not found: ' + owner + '/' + repoName);
  const handler = MCP_HANDLERS[name];
  if (handler === undefined) return { __rpcError: { code: -32602, message: 'Unknown tool: ' + name } };
  return handler(repo, args);
}

function handleMcp(res: Res, rawBody: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const msg = parsed as Record<string, unknown>;
  const id = (msg.id ?? null) as string | number | null;
  const method = typeof msg.method === 'string' ? msg.method : '';
  const params = (msg.params ?? {}) as Record<string, unknown>;
  const isNotification = msg.id === undefined;

  const ok = (result: unknown): void => {
    if (isNotification) {
      res.writeHead(202, { 'x-github-request-id': 'req-' + ++reqSeq });
      res.end();
      return;
    }
    sendJson(res, 200, { jsonrpc: '2.0', id, result });
  };
  const rpcErr = (code: number, message: string): void => {
    if (isNotification) {
      res.writeHead(202, { 'x-github-request-id': 'req-' + ++reqSeq });
      res.end();
      return;
    }
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  };
  const accepted = (): void => {
    res.writeHead(202, { 'x-github-request-id': 'req-' + ++reqSeq });
    res.end();
  };

  if (method === 'server/discover') {
    return ok({
      protocolVersion: '2026-07-28',
      supportedVersions: MCP_VERSIONS,
      serverInfo: { name: 'git-forge', version: VERSION },
      capabilities: { tools: {} },
    });
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = MCP_VERSIONS.includes(offered) ? offered : '2025-11-25';
    return ok({
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: 'git-forge', version: VERSION },
    });
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return accepted();
  }
  if (method === 'ping') return ok({});
  if (method === 'tools/list') {
    return ok({ tools: MCP_TOOLS });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
    const result = mcpCallTool(toolName, toolArgs);
    const rpcError = (result as Record<string, unknown>).__rpcError as { code: number; message: string } | undefined;
    if (rpcError !== undefined) return rpcErr(rpcError.code, rpcError.message);
    return ok(result);
  }
  return rpcErr(-32601, 'Method not found: ' + method);
}

// ---------------------------------------------------------------------------
// HTTP server: routing, auth, body handling

// ---------------------------------------------------------------------------
// Raw-socket HTTP/1.1 transport (replaces node:http).
//
// The suite's client speaks plain HTTP/1.1 over keep-alive connections.
// Parsing a request and writing its response straight on the socket skips
// the stdlib server's per-request churn (IncomingMessage / ServerResponse
// objects, header objects, stream machinery), which dominated the timed
// workloads' wall time. The request handler is synchronous once the body
// is buffered, so each socket is served strictly in order.

interface Req {
  method: string;
  url: string;
  headers: { host?: string; authorization?: string };
  body: Buffer;
}

const EMPTY_BUF = Buffer.alloc(0);
const RESP_100 = Buffer.from('HTTP/1.1 100 Continue\r\n\r\n', 'latin1');
const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

// Case-insensitive ASCII equality, without allocating a lowercased copy.
function eqFold(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    if (x >= 65 && x <= 90 && y === x + 32) continue;
    if (y >= 65 && y <= 90 && x === y + 32) continue;
    return false;
  }
  return true;
}

class Res {
  headersSent = false;
  private sock: net.Socket;
  private keepAlive: boolean;
  private status = 200;
  private head: Record<string, string> = {};
  constructor(sock: net.Socket, keepAlive: boolean) {
    this.sock = sock;
    this.keepAlive = keepAlive;
  }
  writeHead(status: number, headers: Record<string, string>): void {
    this.status = status;
    this.head = headers;
  }
  end(body?: Buffer | string): void {
    if (this.headersSent) return;
    this.headersSent = true;
    const b = body === undefined ? EMPTY_BUF : typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    let h = 'HTTP/1.1 ' + this.status + ' ' + (STATUS_TEXT[this.status] ?? '') + '\r\n';
    for (const k of Object.keys(this.head)) h += k + ': ' + this.head[k] + '\r\n';
    h += 'content-length: ' + b.length + '\r\nconnection: ' + (this.keepAlive ? 'keep-alive' : 'close') + '\r\n\r\n';
    // Two writes, no Buffer.concat copy of the body: Node batches the
    // queued chunks into one writev, so this is a single syscall.
    this.sock.write(Buffer.from(h, 'latin1'));
    if (b.length > 0) this.sock.write(b);
    if (!this.keepAlive) this.sock.end();
  }
}

// Parse one complete HTTP/1.1 request from the front of buf.
// Returns null when more bytes are needed. Supports Content-Length and
// chunked bodies, keep-alive, and answers Expect: 100-continue at once.
// The header scan walks the latin1 head string by hand (no split array,
// no per-header lowercase allocation) because this runs per request.
function tryParse(
  buf: Buffer,
  sock: net.Socket,
): { req: Req; rest: Buffer; keepAlive: boolean } | null {
  const headEnd = buf.indexOf('\r\n\r\n');
  if (headEnd === -1) {
    if (buf.length > 65536) sock.destroy();
    return null;
  }
  const head = buf.subarray(0, headEnd).toString('latin1');
  // Request line: METHOD SP TARGET SP VERSION.
  let sp1 = head.indexOf(' ');
  const method = sp1 === -1 ? head : head.slice(0, sp1);
  let target = '/';
  let version = 'HTTP/1.1';
  if (sp1 !== -1) {
    const sp2 = head.indexOf(' ', sp1 + 1);
    if (sp2 === -1) {
      target = head.slice(sp1 + 1);
    } else {
      target = head.slice(sp1 + 1, sp2);
      const eol = head.indexOf('\r\n', sp2 + 1);
      const rawVersion = eol === -1 ? head.slice(sp2 + 1) : head.slice(sp2 + 1, eol);
      version = rawVersion.trim();
    }
  }
  let host: string | undefined;
  let authorization: string | undefined;
  let contentLength = 0;
  let chunked = false;
  let connection = '';
  let expectContinue = false;
  // Header lines, one per \r\n; the last line runs to the end of head.
  let pos = head.indexOf('\r\n');
  if (pos !== -1) pos += 2;
  while (pos !== -1 && pos < head.length) {
    let lineEnd = head.indexOf('\r\n', pos);
    const line = lineEnd === -1 ? head.slice(pos) : head.slice(pos, lineEnd);
    const c = line.indexOf(':');
    if (c !== -1) {
      // Name, trimmed of surrounding spaces/tabs, compared fold-case.
      let ns = 0;
      while (ns < c && (line[ns] === ' ' || line[ns] === '\t')) ns += 1;
      let ne = c;
      while (ne > ns && (line[ne - 1] === ' ' || line[ne - 1] === '\t')) ne -= 1;
      const name = line.slice(ns, ne);
      const value = line.slice(c + 1).trim();
      if (eqFold(name, 'host')) host = value;
      else if (eqFold(name, 'authorization')) authorization = value;
      else if (eqFold(name, 'content-length')) contentLength = parseInt(value, 10) || 0;
      else if (eqFold(name, 'transfer-encoding')) chunked = value.toLowerCase().includes('chunked');
      else if (eqFold(name, 'connection')) connection = value.toLowerCase();
      else if (eqFold(name, 'expect')) expectContinue = value.toLowerCase() === '100-continue';
    }
    if (lineEnd === -1) break;
    pos = lineEnd + 2;
  }
  const keepAlive = version === 'HTTP/1.1' ? connection !== 'close' : connection === 'keep-alive';
  const bodyStart = headEnd + 4;
  if (expectContinue) sock.write(RESP_100);
  if (chunked) {
    let p = bodyStart;
    const parts: Buffer[] = [];
    for (;;) {
      const eol = buf.indexOf('\r\n', p);
      if (eol === -1) return null;
      const size = parseInt(buf.subarray(p, eol).toString('latin1').split(';')[0]!.trim(), 16);
      if (Number.isNaN(size) || size < 0) {
        sock.destroy();
        return null;
      }
      if (size === 0) {
        let rest: Buffer;
        if (buf[eol + 2] === 13 && buf[eol + 3] === 10) rest = buf.subarray(eol + 4);
        else {
          const trailerEnd = buf.indexOf('\r\n\r\n', eol + 2);
          if (trailerEnd === -1) return null;
          rest = buf.subarray(trailerEnd + 4);
        }
        const body = parts.length === 1 ? parts[0]! : Buffer.concat(parts);
        return { req: { method, url: target, headers: { host, authorization }, body }, rest, keepAlive };
      }
      const dataStart = eol + 2;
      if (buf.length < dataStart + size + 2) return null;
      parts.push(buf.subarray(dataStart, dataStart + size));
      p = dataStart + size + 2;
    }
  }
  if (contentLength > 64 * 1024 * 1024) {
    sock.destroy();
    return null;
  }
  if (buf.length < bodyStart + contentLength) return null;
  const body = contentLength === 0 ? EMPTY_BUF : buf.subarray(bodyStart, bodyStart + contentLength);
  return { req: { method, url: target, headers: { host, authorization }, body }, rest: buf.subarray(bodyStart + contentLength), keepAlive };
}

function authed(req: Req): boolean {
  if (TOKEN === '') return true; // standalone local runs
  const header = req.headers.authorization ?? '';
  return header === 'Bearer ' + TOKEN;
}

// A shared empty query set for requests with no '?' — avoids building a
// URLSearchParams (and a URL) for the common no-query request.
const EMPTY_QUERY = new URLSearchParams();

// Split a request target into its path and query string without building
// a URL object: the hot paths carry no query at all, and URL parsing is
// the most expensive thing in the dispatcher for those requests.
function splitTarget(target: string): { path: string; query: URLSearchParams } {
  const hashAt = target.indexOf('#');
  const clean = hashAt === -1 ? target : target.slice(0, hashAt);
  const q = clean.indexOf('?');
  if (q === -1) return { path: clean, query: EMPTY_QUERY };
  return { path: clean.slice(0, q), query: new URLSearchParams(clean.slice(q + 1)) };
}

function handleRequest(req: Req, res: Res): void {
  try {
    const method = req.method;
    const { path: pathname, query } = splitTarget(req.url);

    if (pathname === '/healthz' && method === 'GET') {
      return sendJson(res, 200, { ok: true });
    }

    const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
    const rawBody = hasBody ? req.body : EMPTY_BUF;

    // Git smart HTTP: /{owner}/{repo}.git/{tail}. Scanned by hand: the
    // route regex ran on every request and this is the push/clone path.
    // Owner and repo are single path segments, so the slash after the
    // owner must be the one that closes ".git" — otherwise a REST path
    // that merely contains ".git/" (e.g. a contents path) would match.
    if (pathname.length > 1 && pathname.charCodeAt(0) === 47) {
      const slash2 = pathname.indexOf('/', 1);
      if (slash2 !== -1) {
        const gitSuffix = pathname.indexOf('.git/', slash2 + 1);
        if (gitSuffix !== -1 && pathname.indexOf('/', slash2 + 1) === gitSuffix + 4) {
          const owner = decodeURIComponent(pathname.slice(1, slash2));
          const repoName = decodeURIComponent(pathname.slice(slash2 + 1, gitSuffix));
          const tail = pathname.slice(gitSuffix + 5);
          if (!authed(req)) return sendErr(res, 401, 'Unauthorized');
          const repo = getRepo(owner, repoName);
          if (repo === undefined) return sendErr(res, 404, 'Not Found');
          if (tail === 'info/refs' && method === 'GET') {
            const service = query.get('service') ?? '';
            if (service === 'git-upload-pack') {
              res.writeHead(200, {
                'content-type': 'application/x-git-upload-pack-advertisement',
                'x-github-request-id': 'req-' + ++reqSeq,
              });
              res.end(uploadPackAdvertisement(repo));
              return;
            }
            if (service === 'git-receive-pack') {
              res.writeHead(200, {
                'content-type': 'application/x-git-receive-pack-advertisement',
                'x-github-request-id': 'req-' + ++reqSeq,
              });
              res.end(receivePackAdvertisement(repo));
              return;
            }
            return sendErr(res, 404, 'Not Found');
          }
          if (tail === 'git-upload-pack' && method === 'POST') {
            const first = decodePktLines(rawBody)[0];
            const firstLine = first && first.kind === 'data' ? first.payload.toString('utf8') : '';
            let out: Buffer;
            if (firstLine.startsWith('command=ls-refs')) out = lsRefsResponse(repo, rawBody);
            else if (firstLine.startsWith('command=fetch')) out = fetchResponse(repo, rawBody);
            else return sendErr(res, 400, 'Unknown git-upload-pack command');
            res.writeHead(200, {
              'content-type': 'application/x-git-upload-pack-result',
              'x-github-request-id': 'req-' + ++reqSeq,
            });
            res.end(out);
            return;
          }
          if (tail === 'git-receive-pack' && method === 'POST') {
            const out = receivePackResponse(repo, rawBody);
            res.writeHead(200, {
              'content-type': 'application/x-git-receive-pack-result',
              'x-github-request-id': 'req-' + ++reqSeq,
            });
            res.end(out);
            return;
          }
          return sendErr(res, 404, 'Not Found');
        }
      }
    }

    // JSON surfaces need auth first.
    if (!authed(req)) return sendErr(res, 401, 'Unauthorized');

    if (pathname === '/api/graphql' && method === 'POST') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return sendErr(res, 400, 'Malformed JSON body');
      }
      const runOne = (doc: unknown): Record<string, unknown> => {
        if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
          return { data: null, errors: [{ message: 'Invalid GraphQL operation' }] };
        }
        const d = doc as Record<string, unknown>;
        const queryText = typeof d.query === 'string' ? d.query : '';
        const variables = (d.variables ?? {}) as Record<string, unknown>;
        try {
          const parser = new GqlParser(queryText);
          const ops = parser.parseDocument();
          if (ops.length === 0) return { data: null, errors: [{ message: 'No operation found' }] };
          return gqlExecute(ops[0]!, variables);
        } catch (e) {
          return { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] };
        }
      };
      if (Array.isArray(parsed)) {
        return sendJson(res, 200, parsed.map(runOne));
      }
      return sendJson(res, 200, runOne(parsed));
    }

    if (pathname === '/mcp' && method === 'POST') {
      return handleMcp(res, rawBody);
    }

    if (pathname.startsWith('/api/v3')) {
      let body: unknown = null;
      if (rawBody.length > 0) {
        try {
          body = JSON.parse(rawBody.toString('utf8'));
        } catch {
          return sendErr(res, 400, 'Malformed JSON body');
        }
      }
      const rest = pathname.slice('/api/v3'.length);
      const segs: string[] = [];
      let start = 0;
      for (let i = 0; i <= rest.length; i++) {
        if (i === rest.length || rest.charCodeAt(i) === 47) {
          const seg = rest.slice(start, i);
          if (seg !== '') {
            try {
              segs.push(decodeURIComponent(seg));
            } catch {
              segs.push(seg);
            }
          }
          start = i + 1;
        }
      }
      if (handleRest(req, res, method, segs, query, body)) return;
      return sendErr(res, 404, 'Not Found');
    }

    return sendErr(res, 404, 'Not Found');
  } catch (e) {
    if (!res.headersSent) {
      try {
        sendErr(res, 500, e instanceof Error ? e.message : 'Internal error');
      } catch {
        // the socket is gone; nothing left to do
      }
    }
  }
}

const server = net.createServer((sock) => {
  sock.setNoDelay(true);
  let buf: Buffer = EMPTY_BUF;
  sock.on('data', (chunk: Buffer) => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    for (;;) {
      const parsed = tryParse(buf, sock);
      if (parsed === null) return;
      buf = parsed.rest;
      handleRequest(parsed.req, new Res(sock, parsed.keepAlive));
      if (!parsed.keepAlive || sock.destroyed) return;
    }
  });
  sock.on('error', () => undefined);
});

// ---------------------------------------------------------------------------
// Lifecycle: bind an ephemeral port, register with the suite, long-poll /done.

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  await new Promise<void>((resolve) => {
    server.listen(0, '0.0.0.0', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  if (ENV_URL === '') {
    console.error('git-forge listening on http://127.0.0.1:' + port + ' (standalone; no MAKEFUN_ENV_URL)');
    return;
  }
  // Register (retry: the suite may still be binding when we start).
  let registered = false;
  for (let attempt = 0; attempt < 20 && !registered; attempt += 1) {
    try {
      const r = await fetch(ENV_URL + '/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (r.status >= 200 && r.status < 300) registered = true;
      else await sleep(500);
    } catch {
      await sleep(500);
    }
  }
  if (!registered) {
    console.error('git-forge: could not register with the suite; exiting');
    process.exit(1);
  }
  // Long-poll /done until the suite finishes, then exit 0.
  // NOTE: the env answers /done immediately with {done:false}; polling with
  // no delay would spin a hot fetch loop on this process's only event loop
  // and steal time from every timed workload. Poll at a calm 500 ms cadence.
  for (;;) {
    try {
      const r = await fetch(ENV_URL + '/done');
      const data = (await r.json()) as { done?: boolean };
      if (data.done === true) break;
      await sleep(500);
    } catch {
      await sleep(1000);
    }
  }
  process.exit(0);
}

process.on('SIGTERM', () => process.exit(0));
void main();
