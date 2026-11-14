import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

@Injectable()
export class PasswordService {
  private dummy?: Promise<string>;
  hash(pw: string) { return argon2.hash(pw, { type: argon2.argon2id }); }
  verify(hash: string, pw: string) { return argon2.verify(hash, pw).catch(() => false); }
  /** Burn comparable time when the account does not exist (reduces user-enumeration via timing). */
  async fakeVerify(pw: string) {
    this.dummy ??= argon2.hash('dummy-password-for-timing', { type: argon2.argon2id });
    await argon2.verify(await this.dummy, pw).catch(() => false);
  }
}
