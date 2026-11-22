// Minimal types for qrcode-terminal (it ships none); avoids an extra @types dependency.
declare module 'qrcode-terminal' {
  const qrcode: {
    generate(text: string, options: { small?: boolean }, callback: (qr: string) => void): void;
  };
  export default qrcode;
}
