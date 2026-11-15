import JsBarcode from 'jsbarcode';
import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';

/** Code 128 for HID barcode scanners. The value is the opaque scan token, never the order number. */
export function Code128({ value, height = 44 }: { value: string; height?: number }) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (ref.current) JsBarcode(ref.current, value, { format: 'CODE128', displayValue: false, margin: 0, height, width: 2 });
  }, [value, height]);
  return <svg ref={ref} role="img" aria-label={`Barcode ${value}`} className="h-auto max-w-full" />;
}

/** QR for phone cameras. */
export function QrCode({ value, size = 96 }: { value: string; size?: number }) {
  const [src, setSrc] = useState('');
  useEffect(() => { QRCode.toDataURL(value, { margin: 0, width: size * 3, errorCorrectionLevel: 'M' }).then(setSrc).catch(() => setSrc('')); }, [value, size]);
  return src ? <img src={src} width={size} height={size} alt={`QR code ${value}`} /> : <div style={{ width: size, height: size }} aria-hidden="true" />;
}
