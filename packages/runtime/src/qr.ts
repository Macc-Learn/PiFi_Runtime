/** Tiny wrapper so the rest of the CLI doesn't depend on qrcode-terminal's callback API. */
import qrcode from 'qrcode-terminal';

export function renderQr(text: string): Promise<string> {
  return new Promise((resolve) => qrcode.generate(text, { small: true }, (qr: string) => resolve(qr)));
}
