// browserQr.js - Utility to generate browser-compatible QR code PNG data URLs
import QRCode from 'qrcode';

/**
 * Generate a PNG data URL for a QR string
 * @param {string} qrString
 * @returns {Promise<string>} PNG data URL
 */
export async function qrToDataURL(qrString) {
  return await QRCode.toDataURL(qrString, { errorCorrectionLevel: 'M', type: 'image/png', width: 256 });
}
