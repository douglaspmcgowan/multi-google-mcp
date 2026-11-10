import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Config } from "../config.js";

/**
 * AES-256-GCM encrypted state file for HTTP (connector) mode. Holds the Google
 * OAuth client and account tokens, plus the connector's own OAuth state
 * (registered clients, code and token hashes). The key comes from
 * MULTI_GOOGLE_STORE_KEY (32 bytes, base64). Nothing here logs a value.
 */

export const STORE_KEY_ENV = "MULTI_GOOGLE_STORE_KEY";
export const DEFAULT_STORE_FILE = path.join(os.homedir(), ".config", "multi-google-mcp", "store.enc");

export interface StoredClient {
  client_id: string;
  client_id_issued_at?: number;
  client_secret?: string;
  client_secret_expires_at?: number;
  redirect_uris: string[];
  /** Set by `npm run clients:approve`; a client without it is pending and gets no code. */
  approved_at?: number;
  [k: string]: unknown;
}

export interface CodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  email: string;
  scopes: string[];
  resource?: string;
  expiresAt: number; // ms
}

export interface TokenRecord {
  clientId: string;
  email: string;
  scopes: string[];
  resource?: string;
  expiresAt: number; // ms
  family: string;
}

export interface StoreState {
  version: 1;
  google: Config;
  clients: Record<string, StoredClient>;
  /** sha256(code) -> record */
  codes: Record<string, CodeRecord>;
  /** sha256(access token) -> record */
  accessTokens: Record<string, TokenRecord>;
  /** sha256(refresh token) -> record */
  refreshTokens: Record<string, TokenRecord>;
  /** sha256(rotated refresh token) -> { family, expiresAt }; a replay revokes the family. */
  usedRefreshTokens: Record<string, { family: string; expiresAt: number }>;
}

export function emptyState(): StoreState {
  return {
    version: 1,
    google: { clientId: "", clientSecret: "", accounts: {} },
    clients: {},
    codes: {},
    accessTokens: {},
    refreshTokens: {},
    usedRefreshTokens: {},
  };
}

/** Decodes and checks the key. Throws a value-free message when absent or malformed. */
export function parseStoreKey(raw: string | undefined): Buffer {
  const v = (raw ?? "").trim();
  if (!v) throw new Error(`${STORE_KEY_ENV} is not set. Run: npm run store:keygen`);
  const key = Buffer.from(v, "base64");
  if (key.length !== 32) throw new Error(`${STORE_KEY_ENV} must be 32 bytes, base64-encoded.`);
  return key;
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function encrypt(key: Buffer, plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({ v: 1, alg: "A256GCM", iv: iv.toString("base64"), tag: tag.toString("base64"), ct: ct.toString("base64") });
}

export function decrypt(key: Buffer, envelope: string): string {
  const e = JSON.parse(envelope) as { v: number; iv: string; tag: string; ct: string };
  if (e.v !== 1) throw new Error("Unsupported store version");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(e.iv, "base64"));
  decipher.setAuthTag(Buffer.from(e.tag, "base64"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(e.ct, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Store decryption failed: wrong MULTI_GOOGLE_STORE_KEY or corrupted file.");
  }
}

/** Lock file held across read-modify-write so a CLI and the running server never lose each other's writes. */
export const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * On Windows a rename over, or a read of, a file another process has open
 * (a reader, an antivirus scan) fails with a transient code. Retry those with
 * growing waits for about 2 s, then rethrow.
 */
const TRANSIENT_FILE_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const TRANSIENT_RETRY_MS = 2_000;
function retryTransient<T>(op: () => T): T {
  const deadline = Date.now() + TRANSIENT_RETRY_MS;
  let wait = 10;
  for (;;) {
    try {
      return op();
    } catch (e: any) {
      if (!TRANSIENT_FILE_CODES.has(e?.code) || Date.now() > deadline) throw e;
      sleepSync(wait);
      wait = Math.min(wait * 2, 200);
    }
  }
}

function acquireLock(lock: string): number {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lock, "wx", 0o600);
      fs.writeSync(fd, String(process.pid));
      return fd;
    } catch (e: any) {
      // Windows reports EPERM/EACCES while another process's lock file is pending deletion.
      if (e?.code !== "EEXIST" && e?.code !== "EPERM" && e?.code !== "EACCES") throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch (s: any) {
        if (s?.code === "ENOENT") continue; // vanished between open and stat
        // Any other stat failure falls through to the deadline check and the wait below.
      }
      if (Date.now() > deadline) throw new Error(`Store is locked (${lock}); retry, or delete the lock file if no multi-google process is running.`);
      sleepSync(20);
    }
  }
}

function releaseLock(lock: string, fd: number): void {
  fs.closeSync(fd);
  fs.rmSync(lock, { force: true });
}

export class EncryptedStore {
  private state: StoreState;
  /** Identity of the file version `state` was read from; a change on disk triggers a re-read. */
  private stamp = "";

  constructor(readonly file: string, private readonly key: Buffer) {
    this.state = emptyState();
    this.reload();
  }

  static open(file: string = DEFAULT_STORE_FILE, env: Record<string, string | undefined> = process.env): EncryptedStore {
    return new EncryptedStore(file, parseStoreKey(env[STORE_KEY_ENV]));
  }

  private get lockFile(): string {
    return `${this.file}.lock`;
  }

  private fileStamp(): string {
    let st: fs.Stats;
    try {
      st = retryTransient(() => fs.statSync(this.file));
    } catch (e: any) {
      // A transient failure must not read as "file absent": reload would then drop the state.
      if (TRANSIENT_FILE_CODES.has(e?.code)) throw e;
      return "";
    }
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  }

  /** Re-reads the file when another process (a CLI, another server) changed it. */
  private reload(): void {
    const stamp = this.fileStamp();
    if (stamp === this.stamp) return;
    this.state = stamp ? { ...emptyState(), ...JSON.parse(decrypt(this.key, retryTransient(() => fs.readFileSync(this.file, "utf8")))) } : emptyState();
    this.stamp = stamp;
  }

  /** Current state, re-read from disk when the file changed since the last read. */
  get data(): StoreState {
    this.reload();
    return this.state;
  }

  /**
   * Applies a change under the file lock: re-read the latest file, apply `fn`,
   * persist atomically (temp file + rename, mode 0600). Concurrent writers
   * (the server and a CLI) therefore merge instead of overwriting each other.
   */
  update<T>(fn: (s: StoreState) => T): T {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const fd = acquireLock(this.lockFile);
    try {
      this.reload();
      const result = fn(this.state);
      this.write();
      return result;
    } finally {
      releaseLock(this.lockFile, fd);
    }
  }

  /** Persists the current state under the lock. */
  save(): void {
    this.update(() => undefined);
  }

  private write(): void {
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, encrypt(this.key, JSON.stringify(this.state)), { mode: 0o600 });
    try {
      retryTransient(() => fs.renameSync(tmp, this.file));
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* Windows: ACLs, not modes */
    }
    this.stamp = this.fileStamp();
  }

  /** Drops expired codes and tokens from `s` (default: the current state). */
  purge(now: number, s: StoreState = this.state): void {
    for (const bag of [s.codes, s.accessTokens, s.refreshTokens, s.usedRefreshTokens] as Array<Record<string, { expiresAt: number }>>) {
      for (const [k, v] of Object.entries(bag)) if (v.expiresAt <= now) delete bag[k];
    }
  }
}
