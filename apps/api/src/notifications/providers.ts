import nodemailer, { type Transporter } from 'nodemailer';

export interface OutgoingEmail { from: string; to: string; subject: string; text: string; html?: string }
export interface EmailProvider { readonly name: string; send(m: OutgoingEmail): Promise<{ ref: string }> }

/** A send failure that retrying cannot fix (e.g. SMTP 5xx: mailbox does not exist). */
export class PermanentSendError extends Error {}

export class SmtpProvider implements EmailProvider {
  readonly name = 'smtp';
  private readonly transport: Transporter;
  constructor(url: string) { this.transport = nodemailer.createTransport(url); }
  async send(m: OutgoingEmail) {
    try {
      const info = await this.transport.sendMail({ from: m.from, to: m.to, subject: m.subject, text: m.text, html: m.html });
      if (info.rejected?.length) throw new PermanentSendError(`recipient rejected: ${info.rejected.join(', ')}`);
      return { ref: String(info.messageId ?? '') };
    } catch (e: any) {
      if (e instanceof PermanentSendError) throw e;
      if (typeof e?.responseCode === 'number' && e.responseCode >= 500) throw new PermanentSendError(e.message);
      throw e;
    }
  }
}
