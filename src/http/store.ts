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

export class EncryptedStore {
  private state: StoreState;

  constructor(readonly file: string, private readonly key: Buffer) {
    this.state = fs.existsSync(file) ? { ...emptyState(), ...JSON.parse(decrypt(key, fs.readFileSync(file, "utf8"))) } : emptyState();
  }

  static open(file: string = DEFAULT_STORE_FILE, env: Record<string, string | undefined> = process.env): EncryptedStore {
    return new EncryptedStore(file, parseStoreKey(env[STORE_KEY_ENV]));
  }

  get data(): StoreState {
    return this.state;
  }

  /** Applies a change and persists atomically (temp file + rename, mode 0600). */
  update<T>(fn: (s: StoreState) => T): T {
    const result = fn(this.state);
    this.save();
    return result;
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, encrypt(this.key, JSON.stringify(this.state)), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* Windows: ACLs, not modes */
    }
  }

  /** Drops expired codes and tokens. */
  purge(now: number): void {
    const s = this.state;
    for (const bag of [s.codes, s.accessTokens, s.refreshTokens, s.usedRefreshTokens] as Array<Record<string, { expiresAt: number }>>) {
      for (const [k, v] of Object.entries(bag)) if (v.expiresAt <= now) delete bag[k];
    }
  }
}
