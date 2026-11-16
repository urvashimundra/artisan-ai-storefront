import QRCode from 'qrcode';

const ERROR_CORRECTION = 'M';
export const QR_QUIET_ZONE_MODULES = 4;

/**
 * Encodes text as a QR code and returns SVG geometry only: the size in modules (quiet zone included) and one path string
 * of 1x1 squares. The template prints these as escaped attribute values, so no markup is ever emitted unescaped.
 * @param {string} text
 * @returns {{ size: number, path: string }}
 */
export function qrPath(text) {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: ERROR_CORRECTION });
  const squares = [];
  for (let row = 0; row < modules.size; row += 1) {
    for (let col = 0; col < modules.size; col += 1) {
      if (modules.get(row, col)) squares.push(`M${col + QR_QUIET_ZONE_MODULES} ${row + QR_QUIET_ZONE_MODULES}h1v1h-1z`);
    }
  }
  return { size: modules.size + QR_QUIET_ZONE_MODULES * 2, path: squares.join('') };
}
