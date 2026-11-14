import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** AES-256-GCM field encryption for secrets at rest (e.g. TOTP seeds). Key comes from env, never source. */
export class FieldCipher {
  private readonly key: Buffer;
  constructor(secret: string) { this.key = createHash('sha256').update(secret).digest(); }
  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
  }
  decrypt(blob: string): string {
    const [v, iv, tag, enc] = blob.split(':');
    if (v !== 'v1') throw new Error('unsupported ciphertext version');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
  }
}

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest();
